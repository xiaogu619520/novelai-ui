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
  if (json?.data && Array.isArray(json.data)) {
    for (const item of json.data) {
      if (item?.b64_json) images.push(`data:image/png;base64,${item.b64_json}`);
      else if (item?.url) images.push(item.url);
    }
  }
  if (images.length === 0 && json?.choices && Array.isArray(json.choices)) {
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
        const mdRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
        let match;
        while ((match = mdRegex.exec(content)) !== null) images.push(match[1]);
        if (images.length === 0 && (content.startsWith('/img/') || content.startsWith('/'))) {
          images.push(`${trimmed}${content}`);
        }
      }
    }
  }
  if (images.length === 0 && json?.candidates) {
    for (const candidate of json.candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inline_data?.mime_type?.startsWith('image/')) {
          images.push(`data:${part.inline_data.mime_type};base64,${part.inline_data.data}`);
        }
      }
    }
  }
  if (images.length === 0 && typeof json?.url === 'string') {
    if (json.url.startsWith('data:image/') || json.url.startsWith('http')) images.push(json.url);
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
    const { apiUrl, apiKey, prompt, model, size } = body;
    if (!apiUrl || !apiKey) {
      return NextResponse.json({ error: '缺少 API 地址或密钥' }, { status: 400 });
    }
    const trimmed = apiUrl.replace(/\/+$/, '');
    const base = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
    const imagesEndpoint = `${base}/images/generations`;
    const chatEndpoint = `${base}/chat/completions`;
    const authHeader = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
    console.log('[ThirdParty] POST', imagesEndpoint);
    const imagesPayload = {
      model,
      prompt,
      n: 1,
      size: size || '1024x1024',
    };
    let resp = await fetch(imagesEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(imagesPayload),
    });
    let contentType = resp.headers.get('content-type') || '';
    if (resp.status === 404) {
      console.log('[ThirdParty] images/generations 404, falling back to chat/completions');
      const chatPayload = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      };
      resp = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify(chatPayload),
      });
      contentType = resp.headers.get('content-type') || '';
    }
    console.log('[ThirdParty] Response status:', resp.status, 'content-type:', contentType);
    if (!resp.ok) {
      let errText = '';
      try { errText = await resp.text(); } catch {}
      let detailedMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error?.message) detailedMsg = errJson.error.message;
        if (errJson.message) detailedMsg = errJson.message;
      } catch {}
      return NextResponse.json({
        error: `API 错误 ${resp.status}: ${detailedMsg || resp.statusText}`,
      }, { status: resp.status });
    }
    return await parseSuccessBody(resp, contentType, trimmed);
  } catch (err: any) {
    console.error('[ThirdParty] Error', err);
    return NextResponse.json({
      error: err?.message || '代理请求失败',
    }, { status: 500 });
  }
}
