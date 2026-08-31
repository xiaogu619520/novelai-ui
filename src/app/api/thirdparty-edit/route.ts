import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const maxDuration = 180;

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

function extractImagesFromJson(json: any): string[] {
  const images: string[] = [];
  if (json?.data && Array.isArray(json.data)) {
    for (const item of json.data) {
      if (item?.b64_json) images.push(`data:image/png;base64,${item.b64_json}`);
      else if (item?.url) images.push(item.url);
    }
  }
  return images;
}

async function parseSuccessBody(resp: Response, contentType: string) {
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
    const images = extractImagesFromJson(json);
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
    const { apiUrl, apiKey, prompt, model, size, image } = body;
    if (!apiUrl || !apiKey || !image) {
      return NextResponse.json({ error: '缺少 API 地址、密钥或底图' }, { status: 400 });
    }
    const trimmed = apiUrl.replace(/\/+$/, '');
    const base = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
    const endpoint = `${base}/images/edits`;
    const authHeader = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
    const base64Match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!base64Match) {
      return NextResponse.json({ error: '图片格式无效，需要 base64 data URI' }, { status: 400 });
    }
    const imgBuffer = Buffer.from(base64Match[2], 'base64');
    const imgExt = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
    const formData = new FormData();
    const blob = new Blob([imgBuffer], { type: `image/${base64Match[1]}` });
    formData.append('image', blob, `image.${imgExt}`);
    formData.append('prompt', prompt || '');
    formData.append('model', model);
    if (size) formData.append('size', size);
    console.log('[ThirdParty-Edit] POST', endpoint, 'model:', model);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
      },
      body: formData,
    });
    const contentType = resp.headers.get('content-type') || '';
    console.log('[ThirdParty-Edit] Response:', resp.status, contentType);
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
    return await parseSuccessBody(resp, contentType);
  } catch (err: any) {
    console.error('[ThirdParty-Edit] Error', err);
    return NextResponse.json({
      error: err?.message || '代理请求失败',
    }, { status: 500 });
  }
}
