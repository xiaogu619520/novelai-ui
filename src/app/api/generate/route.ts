import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiUrl, apiKey, payload } = body;

    if (!apiUrl || !apiKey || !payload) {
      return NextResponse.json({ error: '缺少 API 地址、密钥或请求体' }, { status: 400 });
    }

    // 构造最终请求地址
    const trimmed = apiUrl.replace(/\/+$/, '');
    const endpoint = trimmed.includes('/generate-image') ? trimmed : `${trimmed}/ai/generate-image`;

    console.log('[NAI Proxy] POST', endpoint);
    console.log('[NAI Proxy] Payload:', JSON.stringify(payload, null, 2));

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
        'Accept': 'application/zip, image/png, image/jpeg, */*',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000),
    });

    const contentType = upstream.headers.get('content-type') || '';
    console.log('[NAI Proxy] Response status:', upstream.status, 'content-type:', contentType);

    // 错误响应
    if (!upstream.ok) {
      let errText = '';
      try {
        errText = await upstream.text();
      } catch {}
      console.error('[NAI Proxy] Upstream error body:', errText);
      
      // 尝试解析 JSON 错误中的内部消息
      let detailedMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error?.message) detailedMsg = errJson.error.message;
        if (errJson.message) detailedMsg = errJson.message;
        if (errJson.error?.internal_error) detailedMsg += ` | ${JSON.stringify(errJson.error.internal_error)}`;
      } catch {}
      
      return NextResponse.json({
        error: `上游 API 错误 ${upstream.status}: ${detailedMsg || upstream.statusText}`,
        status: upstream.status,
        rawBody: errText,
        endpoint,
      }, { status: upstream.status });
    }

    // ZIP 格式 (NovelAI 官方格式)
    if (contentType.includes('zip') || contentType.includes('octet-stream')) {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      try {
        const zip = await JSZip.loadAsync(buffer);
        const images: string[] = [];
        
        const filePromises: Promise<void>[] = [];
        zip.forEach((relativePath, file) => {
          if (file.dir) return;
          if (/\.(png|jpe?g|webp)$/i.test(relativePath)) {
            const p = file.async('base64').then(b64 => {
              const mime = relativePath.endsWith('.png') ? 'image/png' 
                : relativePath.endsWith('.webp') ? 'image/webp' 
                : 'image/jpeg';
              images.push(`data:${mime};base64,${b64}`);
            });
            filePromises.push(p);
          }
        });
        
        await Promise.all(filePromises);
        
        if (images.length > 0) {
          return NextResponse.json({ images });
        }
      } catch (zipErr) {
        // ZIP 解析失败则继续尝试其他格式
        console.error('[NAI Proxy] ZIP parse failed', zipErr);
      }
    }

    // 直接图片响应
    if (contentType.includes('image/')) {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const mime = contentType.split(';')[0].trim();
      return NextResponse.json({
        images: [`data:${mime};base64,${buffer.toString('base64')}`]
      });
    }

    // JSON 响应 (兼容 OpenAI 格式 / Base64 / URL)
    if (contentType.includes('json')) {
      const json = await upstream.json();
      const images: string[] = [];
      
      // OpenAI images 格式
      if (json.data && Array.isArray(json.data)) {
        for (const item of json.data) {
          if (item.b64_json) images.push(`data:image/png;base64,${item.b64_json}`);
          else if (item.url) images.push(item.url);
        }
      }
      // 直接 { images: [...] }
      else if (json.images && Array.isArray(json.images)) {
        images.push(...json.images);
      }
      // 直接 { image: "..." }
      else if (json.image) {
        images.push(typeof json.image === 'string' ? json.image : json.image.url);
      }
      
      if (images.length > 0) {
        return NextResponse.json({ images });
      }
      
      return NextResponse.json({ error: '响应中未找到图像数据', raw: json }, { status: 500 });
    }

    // 兜底：尝试作为二进制图像
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > 100) {
      // 检测 PNG 魔数
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return NextResponse.json({ images: [`data:image/png;base64,${buffer.toString('base64')}`] });
      }
      // 检测 JPEG 魔数
      if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        return NextResponse.json({ images: [`data:image/jpeg;base64,${buffer.toString('base64')}`] });
      }
    }

    return NextResponse.json({ error: `未识别的响应类型: ${contentType}` }, { status: 500 });

  } catch (err: any) {
    console.error('[NAI Proxy] Error', err);
    return NextResponse.json({ 
      error: err?.message || '代理请求失败' 
    }, { status: 500 });
  }
}
