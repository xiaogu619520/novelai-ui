import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const maxDuration = 300;

function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const gif = buf.slice(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function extractImagesFromJson(json: any, trimmed: string): string[] {
  const images: string[] = [];
  if (json?.choices && Array.isArray(json.choices)) {
    for (const choice of json.choices) {
      const content = choice.message?.content || choice.delta?.content || '';
      if (!content) continue;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'image_url' && part.image_url?.url) images.push(part.image_url.url);
          if (part.inline_data?.mime_type?.startsWith('image/') && part.inline_data?.data) {
            images.push(`data:${part.inline_data.mime_type};base64,${part.inline_data.data}`);
          }
        }
        continue;
      }
      if (typeof content !== 'string') continue;
      if (content.startsWith('data:image/')) images.push(content);
      else if (content.startsWith('http://') || content.startsWith('https://')) images.push(content);
      else {
        const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
        if (mdMatch) images.push(mdMatch[1]);
        else if (content.startsWith('/img/') || content.startsWith('/')) images.push(`${trimmed}${content}`);
      }
    }
  }
  if (images.length === 0 && json?.data && Array.isArray(json.data)) {
    for (const item of json.data) {
      if (item?.b64_json) images.push(`data:image/png;base64,${item.b64_json}`);
      else if (item?.url) images.push(item.url);
    }
  }
  if (images.length === 0 && typeof json?.url === 'string') {
    if (json.url.startsWith('data:image/')) images.push(json.url);
    else if (json.url.startsWith('http')) images.push(json.url);
    else images.push(`${trimmed}${json.url}`);
  }
  return images;
}

async function parseSuccessBody(resp: Response, contentType: string, trimmed: string) {
  const buffer = Buffer.from(await resp.arrayBuffer());
  const magicMime = detectImageMime(buffer);
  if (magicMime || contentType.includes('image/')) {
    const mime = magicMime || contentType.split(';')[0].trim();
    return NextResponse.json({
      images: [`data:${mime};base64,${buffer.toString('base64')}`],
    });
  }

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{') || text.startsWith('[') || contentType.includes('json')) {
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: `响应不是有效 JSON: ${contentType}` }, { status: 500 });
    }
    const images = extractImagesFromJson(json, trimmed);
    if (images.length > 0) return NextResponse.json({ images });
    return NextResponse.json({ error: '响应中未找到图像数据', raw: json }, { status: 500 });
  }
  if (text.startsWith('data:image/')) {
    return NextResponse.json({ images: [text] });
  }
  if (text.startsWith('http://') || text.startsWith('https://')) {
    return NextResponse.json({ images: [text] });
  }
  return NextResponse.json({ error: `未识别的响应类型: ${contentType}` }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiUrl, apiKey, prompt, negativePrompt, model, width, height, steps, cfgScale, sampler, seed } = body;
    if (!apiUrl || !apiKey) {
      return NextResponse.json({ error: '缺少 API 地址或密钥' }, { status: 400 });
    }
    const trimmed = apiUrl.replace(/\/+$/, '');
    const base = trimmed.endsWith('/v1') ? trimmed : trimmed + '/v1';
    const endpoint = base + '/chat/completions';
    const sizeStr = `${width}:${height}`;
    const openaiPayload = {
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      size: sizeStr,
      negative_prompt: negativePrompt || '',
      sampler: sampler || 'k_euler_ancestral',
      return_base64: true,
      stream: false,
    };
    console.log('[OpenAI Proxy] POST', endpoint);
    console.log('[OpenAI Proxy] Payload:', JSON.stringify(openaiPayload, null, 2));
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openaiPayload),
    });
    const contentType = upstream.headers.get('content-type') || '';
    console.log('[OpenAI Proxy] Response status:', upstream.status, 'content-type:', contentType);
    if (!upstream.ok) {
      let errText = '';
      try { errText = await upstream.text(); } catch {}
      console.error('[OpenAI Proxy] Upstream error:', errText);
      let detailedMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error?.message) detailedMsg = errJson.error.message;
        if (errJson.message) detailedMsg = errJson.message;
      } catch {}
      return NextResponse.json({
        error: `上游 API 错误 ${upstream.status}: ${detailedMsg || upstream.statusText}`,
      }, { status: upstream.status });
    }
    return await parseSuccessBody(upstream, contentType, trimmed);
  } catch (err: any) {
    console.error('[OpenAI Proxy] Error', err);
    return NextResponse.json({
      error: err?.message || '代理请求失败',
    }, { status: 500 });
  }
}
