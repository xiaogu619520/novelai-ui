"use client";

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { 
  Settings2, Image as ImageIcon, Sparkles, 
  Wand2, RefreshCw, Layers, Scroll, Feather, 
  Flame, Hash, MousePointerClick, Link as LinkIcon,
  Users, ImagePlus, Code, Plus, X, Upload, Trash2,
  Copy, Download, Eye, EyeOff, Paintbrush, ChevronDown, ChevronUp,
  Menu, PenTool, Clock, Archive, FileUp
} from 'lucide-react';

type CharacterPrompt = {
  prompt: string;
  uc: string;
  gender: 'female' | 'male' | 'other';
  position: string; // "AI Choice" or "A1"..."E5"
};

type VibeEntry = {
  image: string;
  strength: number;
  info: number;
};

// ====== IndexedDB 图片存储 ======
type SavedImage = {
  id: string;
  image: string;        // base64 data URL
  prompt: string;
  negativePrompt: string;
  model: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  timestamp: number;
};

const DB_NAME = 'novelai_gallery';
const DB_VERSION = 1;
const STORE_NAME = 'images';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSaveImage(entry: SavedImage): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbLoadAllImages(): Promise<SavedImage[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('timestamp');
    const req = idx.openCursor(null, 'prev'); // 最新的在前
    const results: SavedImage[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(cursor.value as SavedImage);
        cursor.continue();
      } else {
        db.close();
        resolve(results);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbDeleteImage(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbClearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ====== PNG 元数据解析器 ======
type PngMetadata = {
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  scale?: number;
  sampler?: string;
  seed?: number;
  noiseSchedule?: string;
  sm?: boolean;
  smDyn?: boolean;
  cfgRescale?: number;
  uncondScale?: number;
  thumbnail?: string; // base64 预览图
};

function parsePngChunks(buffer: ArrayBuffer): Record<string, string> {
  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8');
  const chunks: Record<string, string> = {};
  let offset = 8; // 跳过 PNG 签名
  while (offset < buffer.byteLength - 4) {
    const length = view.getUint32(offset);
    const typeBytes = new Uint8Array(buffer, offset + 4, 4);
    const type = String.fromCharCode(...typeBytes);
    if (type === 'tEXt') {
      const data = new Uint8Array(buffer, offset + 8, length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const key = decoder.decode(data.slice(0, nullIdx));
        const val = decoder.decode(data.slice(nullIdx + 1));
        chunks[key] = val;
      }
    } else if (type === 'iTXt') {
      const data = new Uint8Array(buffer, offset + 8, length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const key = decoder.decode(data.slice(0, nullIdx));
        // iTXt: keyword \0 compression_flag \0 compression_method \0 language \0 translated \0 text
        let pos = nullIdx + 1;
        const compressionFlag = data[pos]; pos++;
        pos++; // compression method
        // skip language tag
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++; // skip null
        // skip translated keyword
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++; // skip null
        if (compressionFlag === 0) {
          chunks[key] = decoder.decode(data.slice(pos));
        } else {
          // zlib compressed - try DecompressionStream
          try {
            const compressed = data.slice(pos);
            chunks[key] = decoder.decode(compressed); // fallback: raw
          } catch {}
        }
      }
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length; // 4(length) + 4(type) + length + 4(CRC)
  }
  return chunks;
}

function extractNaiMetadata(chunks: Record<string, string>): PngMetadata | null {
  const result: PngMetadata = {};
  let found = false;

  // ====== NovelAI 格式 ======
  // Description = prompt, Comment = JSON参数
  if (chunks['Description']) {
    result.prompt = chunks['Description'];
    found = true;
  }
  if (chunks['Comment']) {
    try {
      const comment = JSON.parse(chunks['Comment']);
      if (comment.uc) { result.negativePrompt = comment.uc; found = true; }
      if (comment.steps) result.steps = comment.steps;
      if (comment.scale) result.scale = comment.scale;
      if (comment.sampler) result.sampler = comment.sampler;
      if (comment.seed !== undefined) result.seed = comment.seed;
      if (comment.width) result.width = comment.width;
      if (comment.height) result.height = comment.height;
      if (comment.noise_schedule) result.noiseSchedule = comment.noise_schedule;
      if (comment.sm !== undefined) result.sm = comment.sm;
      if (comment.sm_dyn !== undefined) result.smDyn = comment.sm_dyn;
      if (comment.cfg_rescale !== undefined) result.cfgRescale = comment.cfg_rescale;
      if (comment.uncond_scale !== undefined) result.uncondScale = comment.uncond_scale;
      found = true;
    } catch {}
  }
  // Source 中可能有模型信息
  if (chunks['Source']) {
    const src = chunks['Source'];
    if (src.includes('Stable Diffusion')) {
      // NovelAI 官方 Source 格式
      found = true;
    }
  }

  // ====== Stable Diffusion WebUI (A1111) 格式 ======
  // parameters chunk: "prompt\nNegative prompt: xxx\nSteps: 28, Sampler: ..., CFG scale: ..., Seed: ..., Size: WxH, Model: ..."
  if (!found && chunks['parameters']) {
    const params = chunks['parameters'];
    const negIdx = params.indexOf('Negative prompt:');
    const stepsIdx = params.search(/\nSteps:/);

    if (negIdx >= 0) {
      result.prompt = params.substring(0, negIdx).trim();
      if (stepsIdx > negIdx) {
        result.negativePrompt = params.substring(negIdx + 16, stepsIdx).trim();
      } else {
        result.negativePrompt = params.substring(negIdx + 16).trim();
      }
    } else if (stepsIdx >= 0) {
      result.prompt = params.substring(0, stepsIdx).trim();
    } else {
      result.prompt = params.trim();
    }

    // 解析 "Steps: 28, Sampler: xxx, CFG scale: 7, Seed: 12345, Size: 512x768, Model: ..."
    const metaLine = stepsIdx >= 0 ? params.substring(stepsIdx) : '';
    const stepsMatch = metaLine.match(/Steps:\s*(\d+)/);
    if (stepsMatch) result.steps = parseInt(stepsMatch[1]);
    const samplerMatch = metaLine.match(/Sampler:\s*([^,]+)/);
    if (samplerMatch) result.sampler = samplerMatch[1].trim();
    const cfgMatch = metaLine.match(/CFG scale:\s*([\d.]+)/);
    if (cfgMatch) result.scale = parseFloat(cfgMatch[1]);
    const seedMatch = metaLine.match(/Seed:\s*(\d+)/);
    if (seedMatch) result.seed = parseInt(seedMatch[1]);
    const sizeMatch = metaLine.match(/Size:\s*(\d+)x(\d+)/);
    if (sizeMatch) { result.width = parseInt(sizeMatch[1]); result.height = parseInt(sizeMatch[2]); }
    const modelMatch = metaLine.match(/Model:\s*([^,]+)/);
    if (modelMatch) result.model = modelMatch[1].trim();
    found = true;
  }

  // ====== ComfyUI 格式 (prompt chunk 包含 JSON workflow) ======
  if (!found && chunks['prompt']) {
    try {
      const workflow = JSON.parse(chunks['prompt']);
      // 尝试从 workflow nodes 中提取参数
      for (const nodeId of Object.keys(workflow)) {
        const node = workflow[nodeId];
        if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
          if (node.inputs) {
            if (node.inputs.steps) result.steps = node.inputs.steps;
            if (node.inputs.cfg) result.scale = node.inputs.cfg;
            if (node.inputs.sampler_name) result.sampler = node.inputs.sampler_name;
            if (node.inputs.seed) result.seed = node.inputs.seed;
          }
        }
        if (node.class_type === 'CLIPTextEncode' && node.inputs?.text) {
          if (!result.prompt) result.prompt = node.inputs.text;
          else if (!result.negativePrompt) result.negativePrompt = node.inputs.text;
        }
      }
      if (result.prompt) found = true;
    } catch {}
  }

  return found ? result : null;
}

async function parsePngMetadata(file: File): Promise<{ metadata: PngMetadata | null; thumbnail: string }> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      const chunks = parsePngChunks(buffer);
      const metadata = extractNaiMetadata(chunks);

      // 生成缩略图
      const blob = new Blob([buffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      resolve({ metadata, thumbnail: url });
    };
    reader.readAsArrayBuffer(file);
  });
}

// ====== localStorage 持久化工具 ======
const STORAGE_KEY = 'nai_settings';

type PersistedSettings = {
  apiUrl: string;
  apiKey: string;
  prompt: string;
  negativePrompt: string;
  qualityPrompt: string;
  qualityToggle: boolean;
  model: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  seed: number;
  nSamples: number;
  sampler: string;
  ucPreset: number;
  noiseSchedule: string;
  cfgRescale: number;
  uncondScale: number;
  sm: boolean;
  smDyn: boolean;
  decrisper: boolean;
  varietyBoost: boolean;
  characters: CharacterPrompt[];
  imgStrength: number;
  imgNoise: number;
  apiFormat: 'novelai' | 'openai' | 'thirdparty';
  thirdpartyModel: string;
  customModels: string[];
  openaiModel: string;
  openaiCustomModels: string[];
  naiCustomModels: string[];
};

function loadSettings(): Partial<PersistedSettings> {
  try {
    // 先迁移旧的单独 key
    const old: Partial<PersistedSettings> = {};
    const oldUrl = localStorage.getItem('nai_api_url');
    const oldKey = localStorage.getItem('nai_api_key');
    if (oldUrl) { old.apiUrl = oldUrl; localStorage.removeItem('nai_api_url'); }
    if (oldKey) { old.apiKey = oldKey; localStorage.removeItem('nai_api_key'); }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...parsed, ...old }; // 旧 key 覆盖
    }
    return old;
  } catch { return {}; }
}

function saveSettings(settings: PersistedSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
}

export default function NovelAIUI() {
  // ====== 是否已从 localStorage 加载完毕 ======
  const [loaded, setLoaded] = useState(false);

  // ====== API 配置 ======
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiFormat, setApiFormat] = useState<'novelai' | 'openai' | 'thirdparty'>('novelai');

  // ====== 第三方模型 ======
  const [thirdpartyModel, setThirdpartyModel] = useState('gpt-image-1');
  const [customModels, setCustomModels] = useState<string[]>(['gpt-image-1', 'dall-e-3', 'gemini-2.0-flash-preview-image-generation']);

  // ====== OpenAI 自定义模型 ======
  const [openaiModel, setOpenaiModel] = useState('nai-diffusion-5-full');
  const [openaiCustomModels, setOpenaiCustomModels] = useState<string[]>(['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'gpt-image-1']);

  // ====== 生成结果 ======
  const [resultImages, setResultImages] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // ====== 基础咒语 ======
  const [qualityToggle, setQualityToggle] = useState(true);
  const [qualityPrompt, setQualityPrompt] = useState('best quality, amazing quality, very aesthetic, absurdres');
  const [prompt, setPrompt] = useState('1girl, solo, masterpiece');
  const [negativePrompt, setNegativePrompt] = useState('lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, blurry');
  
  // ====== 多角色 (V4+) ======
  const [characters, setCharacters] = useState<CharacterPrompt[]>([
    { prompt: 'purple hair, smile', uc: '', gender: 'female', position: 'AI Choice' }
  ]);
  
  // ====== 氛围迁移 ======
  const [vibes, setVibes] = useState<VibeEntry[]>([]);

  // ====== 图生图 / 局部重绘 ======
  const [action, setAction] = useState<'generate' | 'img2img' | 'infill'>('generate');
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [maskImage, setMaskImage] = useState<string | null>(null);
  const [imgStrength, setImgStrength] = useState(0.7);
  const [imgNoise, setImgNoise] = useState(0);

  // ====== 基础参数 ======
  const [width, setWidth] = useState(832);
  const [height, setHeight] = useState(1216);
  const [steps, setSteps] = useState(28);
  const [cfgScale, setCfgScale] = useState(6.0);
  const [seed, setSeed] = useState(0);
  const [nSamples, setNSamples] = useState(1);
  const [model, setModel] = useState('nai-diffusion-4-5-full');
  // ====== NAI 自定义模型 ======
  const [naiCustomModels, setNaiCustomModels] = useState<string[]>([]);
  const [sampler, setSampler] = useState('k_euler_ancestral');
  
  // ====== 高级参数 ======
  const [ucPreset, setUcPreset] = useState(0);
  const [noiseSchedule, setNoiseSchedule] = useState('karras');
  const [cfgRescale, setCfgRescale] = useState(0);
  const [uncondScale, setUncondScale] = useState(1.0);
  const [sm, setSm] = useState(false);
  const [smDyn, setSmDyn] = useState(false);
  const [decrisper, setDecrisper] = useState(false);
  const [varietyBoost, setVarietyBoost] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<'prompts'|'characters'|'vibe'|'img2img'>('prompts');
  const [showPreview, setShowPreview] = useState(false);

  // ====== 移动端面板切换 ======
  const [mobilePanel, setMobilePanel] = useState<'settings'|'prompts'|'results'>('prompts');

  // ====== 历史画廊 ======
  const [savedImages, setSavedImages] = useState<SavedImage[]>([]);
  const [resultTab, setResultTab] = useState<'current'|'gallery'>('current');
  const [previewImage, setPreviewImage] = useState<SavedImage | null>(null);

  // ====== 元数据导入 ======
  const [showImportModal, setShowImportModal] = useState(false);
  const [importedMeta, setImportedMeta] = useState<PngMetadata | null>(null);
  const [importThumbnail, setImportThumbnail] = useState<string>('');
  const importFileRef = useRef<HTMLInputElement>(null);

  const vibeFileRef = useRef<HTMLInputElement>(null);

  // ====== 启动时加载所有持久化数据 ======
  useEffect(() => {
    const s = loadSettings();
    if (s.apiUrl !== undefined) setApiUrl(s.apiUrl);
    if (s.apiKey !== undefined) setApiKey(s.apiKey);
    if (s.prompt !== undefined) setPrompt(s.prompt);
    if (s.negativePrompt !== undefined) setNegativePrompt(s.negativePrompt);
    if (s.qualityPrompt !== undefined) setQualityPrompt(s.qualityPrompt);
    if (s.qualityToggle !== undefined) setQualityToggle(s.qualityToggle);
    if (s.model !== undefined) setModel(s.model);
    if (s.width !== undefined) setWidth(s.width);
    if (s.height !== undefined) setHeight(s.height);
    if (s.steps !== undefined) setSteps(s.steps);
    if (s.cfgScale !== undefined) setCfgScale(s.cfgScale);
    if (s.seed !== undefined) setSeed(s.seed);
    if (s.nSamples !== undefined) setNSamples(s.nSamples);
    if (s.sampler !== undefined) setSampler(s.sampler);
    if (s.ucPreset !== undefined) setUcPreset(s.ucPreset);
    if (s.noiseSchedule !== undefined) setNoiseSchedule(s.noiseSchedule);
    if (s.cfgRescale !== undefined) setCfgRescale(s.cfgRescale);
    if (s.uncondScale !== undefined) setUncondScale(s.uncondScale);
    if (s.sm !== undefined) setSm(s.sm);
    if (s.smDyn !== undefined) setSmDyn(s.smDyn);
    if (s.decrisper !== undefined) setDecrisper(s.decrisper);
    if (s.varietyBoost !== undefined) setVarietyBoost(s.varietyBoost);
    if (s.characters !== undefined && s.characters.length > 0) setCharacters(s.characters);
    if (s.imgStrength !== undefined) setImgStrength(s.imgStrength);
    if (s.imgNoise !== undefined) setImgNoise(s.imgNoise);
    if (s.apiFormat !== undefined) setApiFormat(s.apiFormat);
    if (s.thirdpartyModel !== undefined) setThirdpartyModel(s.thirdpartyModel);
    if (s.customModels !== undefined && s.customModels.length > 0) setCustomModels(s.customModels);
    if (s.openaiModel !== undefined) setOpenaiModel(s.openaiModel);
    if (s.openaiCustomModels !== undefined && s.openaiCustomModels.length > 0) setOpenaiCustomModels(s.openaiCustomModels);
    if (s.naiCustomModels !== undefined && s.naiCustomModels.length > 0) setNaiCustomModels(s.naiCustomModels);
    setLoaded(true);

    // 加载历史图片
    dbLoadAllImages().then(setSavedImages).catch(console.error);
  }, []);

  // ====== 自动保存所有设置到 localStorage ======
  useEffect(() => {
    if (!loaded) return; // 等待首次加载完毕后才开始保存
    saveSettings({
      apiUrl, apiKey, prompt, negativePrompt, qualityPrompt, qualityToggle,
      model, width, height, steps, cfgScale, seed, nSamples, sampler,
      ucPreset, noiseSchedule, cfgRescale, uncondScale,
      sm, smDyn, decrisper, varietyBoost, characters, imgStrength, imgNoise, apiFormat,
      thirdpartyModel, customModels, openaiModel, openaiCustomModels, naiCustomModels,
    });
  }, [loaded, apiUrl, apiKey, prompt, negativePrompt, qualityPrompt, qualityToggle,
      model, width, height, steps, cfgScale, seed, nSamples, sampler,
      ucPreset, noiseSchedule, cfgRescale, uncondScale,
      sm, smDyn, decrisper, varietyBoost, characters, imgStrength, imgNoise, apiFormat,
      thirdpartyModel, customModels, openaiModel, openaiCustomModels, naiCustomModels]);

  // ====== 枚举列表 ======
  const MODELS = [
    { value: 'nai-diffusion-5-full', label: 'V5 Full (完整版)' },
    { value: 'nai-diffusion-5-curated', label: 'V5 Curated (精选版)' },
    { value: 'nai-diffusion-4-5-full', label: 'V4.5 Full (完整版)' },
    { value: 'nai-diffusion-4-5-curated', label: 'V4.5 Curated (精选版)' },
    { value: 'nai-diffusion-4-full', label: 'V4 Full (完整版)' },
    { value: 'nai-diffusion-4-curated-preview', label: 'V4 Curated (精选版)' },
    { value: 'nai-diffusion-3', label: 'V3 Anime (动漫)' },
    { value: 'nai-diffusion-furry-3', label: 'V3 Furry (兽人)' },
    { value: 'nai-diffusion-2', label: 'V2' },
    { value: 'nai-diffusion', label: 'V1 Full' },
    { value: 'safe-diffusion', label: 'V1 Curated' },
    { value: 'nai-diffusion-furry', label: 'V1 Furry' },
  ];

  const INPAINTING_MODELS = [
    { value: 'nai-diffusion-5-full-inpainting', label: 'V5 Full Inpainting' },
    { value: 'nai-diffusion-4-full-inpainting', label: 'V4 Full Inpainting' },
    { value: 'nai-diffusion-4-curated-inpainting', label: 'V4 Curated Inpainting' },
    { value: 'nai-diffusion-3-inpainting', label: 'V3 Inpainting' },
    { value: 'nai-diffusion-furry-3-inpainting', label: 'V3 Furry Inpainting' },
  ];

  const SAMPLERS = [
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
    { value: 'ddim_v3', label: 'DDIM V3' },
  ];

  const UC_PRESETS = [
    { value: 0, label: 'Heavy (重度过滤)' },
    { value: 1, label: 'Light (轻度过滤)' },
    { value: 2, label: 'Human Focus (人物聚焦)' },
    { value: 3, label: 'None (不使用)' },
  ];

  const NOISE_SCHEDULES = [
    { value: 'native', label: 'Native' },
    { value: 'karras', label: 'Karras' },
    { value: 'exponential', label: 'Exponential' },
    { value: 'polyexponential', label: 'Polyexponential' },
  ];

  const isV4Model = model.includes('nai-diffusion-4') || model.includes('nai-diffusion-5');
  const isFurryModel = model.includes('furry');

  // A1-E5 位置 → x,y 坐标 (0-1)
  const positionToCoords = (pos: string) => {
    if (pos === 'AI Choice') return null;
    const col = pos.charCodeAt(0) - 'A'.charCodeAt(0);
    const row = parseInt(pos[1]) - 1;
    return { x: (col + 0.5) / 5, y: (row + 0.5) / 5 };
  };

  const genderToTag = (g: string) => g === 'male' ? 'boy' : g === 'other' ? 'other' : 'girl';

  // 构建完整请求 JSON
  const buildRequestBody = () => {
    const finalInput = qualityToggle ? `${prompt}, ${qualityPrompt}` : prompt;
    
    // 中转服务器限制：分辨率必须是 832×1216 / 1216×832 / 1024×1024，步数≤28
    const allowedResolutions = [[832, 1216], [1216, 832], [1024, 1024]];
    let safeWidth = width, safeHeight = height;
    if (!allowedResolutions.some(([w, h]) => w === width && h === height)) {
      // 根据长宽比自动选择最接近的
      const ratio = width / height;
      if (ratio < 0.9) { safeWidth = 832; safeHeight = 1216; }
      else if (ratio > 1.1) { safeWidth = 1216; safeHeight = 832; }
      else { safeWidth = 1024; safeHeight = 1024; }
    }
    const safeSteps = Math.min(steps, 28);
    
    const parameters: any = {
      width: safeWidth,
      height: safeHeight,
      steps: safeSteps,
      scale: cfgScale,
      sampler,
      seed: seed === 0 ? Math.floor(Math.random() * 4294967295) : seed,
      n_samples: nSamples,
      negative_prompt: negativePrompt,
      quality_toggle: qualityToggle,
      uc_preset: ucPreset,
      noise_schedule: noiseSchedule,
      cfg_rescale: cfgRescale,
      uncond_scale: uncondScale,
      sm,
      sm_dyn: smDyn,
      dynamic_thresholding: decrisper,
    };

    if (varietyBoost) parameters.skip_cfg_above_sigma = 19;

    if (action === 'img2img' && baseImage) {
      parameters.image = baseImage.replace(/^data:image\/\w+;base64,/, '');
      parameters.strength = imgStrength;
      parameters.noise = imgNoise;
    }

    if (action === 'infill' && baseImage && maskImage) {
      parameters.image = baseImage.replace(/^data:image\/\w+;base64,/, '');
      parameters.mask = maskImage.replace(/^data:image\/\w+;base64,/, '');
    }

    if (vibes.length > 0) {
      parameters.reference_image_multiple = vibes.map(v => v.image.replace(/^data:image\/\w+;base64,/, ''));
      parameters.reference_strength_multiple = vibes.map(v => v.strength);
      parameters.reference_information_extracted_multiple = vibes.map(v => v.info);
    }

    // V4+ 多角色 — 仅当用户添加了 2+ 有效角色时才发送（bailan中转对此参数支持有限）
    const validChars = characters.filter(c => c.prompt.trim());
    if (isV4Model && validChars.length >= 2) {
      const charCaptions = validChars.map(c => {
        const coords = positionToCoords(c.position);
        const genderTag = genderToTag(c.gender);
        return {
          char_caption: `${genderTag}, ${c.prompt}`,
          centers: coords ? [coords] : [{ x: 0.5, y: 0.5 }],
        };
      });

      parameters.v4_prompt = {
        caption: {
          base_caption: prompt,
          char_captions: charCaptions,
          base_caption_dropout: 0,
          is_nsfw: false, is_furry: isFurryModel,
          is_photo: false, is_unsplash: false,
          is_tags: true, is_gel: true,
        },
        use_coords: characters.some(c => c.position !== 'AI Choice'),
        use_order: true,
      };

      parameters.v4_negative_prompt = {
        caption: {
          base_caption: negativePrompt,
          char_captions: validChars.map(c => ({ char_caption: c.uc || '', centers: [] })),
          base_caption_dropout: 0,
          is_nsfw: false, is_furry: isFurryModel,
          is_photo: false, is_unsplash: false,
          is_tags: false, is_gel: false,
        },
        use_coords: false,
        use_order: true,
      };
    }

    return { input: finalInput, model, action, parameters };
  };

  const handleGenerate = async () => {
    if (!apiUrl.trim() || !apiKey.trim()) {
      setErrorMsg('请先在左侧填写 API 地址和密钥');
      return;
    }
    
    setIsGenerating(true);
    setErrorMsg('');
    setResultImages([]);

    const actualSeed = seed === 0 ? Math.floor(Math.random() * 4294967295) : seed;
    
    const controller = new AbortController();
    const timeoutMs = apiFormat === 'thirdparty' ? 180000 : 120000; // 第三方3分钟, 其他2分钟
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let resp: Response;

      if (apiFormat === 'thirdparty') {
        // 第三方图片生成 API (GPT-image, DALL-E, Gemini 等)
        if (baseImage) {
          // 图生图: /v1/images/edits
          resp = await fetch('/api/thirdparty-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiUrl: apiUrl.trim(),
              apiKey: apiKey.trim(),
              prompt: prompt,
              model: thirdpartyModel,
              size: `${width}x${height}`,
              image: baseImage,
            }),
            signal: controller.signal,
          });
        } else {
          // 文生图: /v1/images/generations
          resp = await fetch('/api/thirdparty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiUrl: apiUrl.trim(),
              apiKey: apiKey.trim(),
              prompt: prompt,
              model: thirdpartyModel,
              size: `${width}x${height}`,
            }),
            signal: controller.signal,
          });
        }
      } else if (apiFormat === 'openai') {
        // OpenAI chat/completions 格式
        const finalPrompt = qualityToggle ? `${prompt}, ${qualityPrompt}` : prompt;
        resp = await fetch('/api/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiUrl: apiUrl.trim(),
            apiKey: apiKey.trim(),
            prompt: finalPrompt,
            negativePrompt,
            model: openaiModel,
            width,
            height,
            steps,
            cfgScale,
            sampler,
            seed: actualSeed,
          }),
          signal: controller.signal,
        });
      } else {
        // NovelAI 官方格式
        const payload = buildRequestBody();
        resp = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiUrl: apiUrl.trim(),
            apiKey: apiKey.trim(),
            payload,
          }),
          signal: controller.signal,
        });
      }

      clearTimeout(timeout);
      
      const data = await resp.json();
      
      if (!resp.ok) {
        throw new Error(data.error || `请求失败 (${resp.status})`);
      }
      
      if (data.images && data.images.length > 0) {
        setResultImages(data.images);
        // 自动保存到 IndexedDB
        const ts = Date.now();
        const newEntries: SavedImage[] = data.images.map((img: string, i: number) => ({
          id: `${ts}-${i}`,
          image: img,
          prompt,
          negativePrompt,
          model: apiFormat === 'thirdparty' ? thirdpartyModel : apiFormat === 'openai' ? openaiModel : model,
          width,
          height,
          steps,
          seed: actualSeed,
          timestamp: ts,
        }));
        for (const entry of newEntries) {
          await dbSaveImage(entry);
        }
        setSavedImages(prev => [...newEntries, ...prev]);
      } else {
        throw new Error('服务端未返回图像');
      }
    } catch (err: any) {
      console.error(err);
      if (err.name === 'AbortError') {
        setErrorMsg(`生成超时（${timeoutMs / 1000}秒）。第三方模型生图通常需要30-60秒，请重试。`);
      } else {
        setErrorMsg(err.message || '生成失败，请检查配置');
      }
    } finally {
      clearTimeout(timeout);
      setIsGenerating(false);
    }
  };

  const handleDownloadImage = (img: string, index: number) => {
    const a = document.createElement('a');
    a.href = img;
    a.download = `novelai-${Date.now()}-${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleGenerateRegex = () => {
    const body = buildRequestBody();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const modelShort = model.replace('nai-diffusion-', 'v').replace('-full', 'F').replace('-curated', 'C').replace('-preview', 'P');
    const fileName = `NAI_${modelShort}_${width}x${height}_s${steps}_${timestamp}.json`;
    const regexConfig = {
      name: `NAI ${modelShort} ${width}x${height}`,
      findRegex: "/image###(.*?)###/g",
      replaceString: `<img class="nai-img" alt="$1" />`,
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: true,
      substituteRegex: 0,
      apiPayload: body,
    };
    const blob = new Blob([JSON.stringify(regexConfig, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyRequest = () => {
    navigator.clipboard.writeText(JSON.stringify(buildRequestBody(), null, 2));
    alert('请求体已复制到剪贴板！');
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, target: 'img2img' | 'vibe' | 'mask') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target?.result as string;
        if (target === 'img2img') setBaseImage(result);
        else if (target === 'mask') setMaskImage(result);
        else setVibes([...vibes, { image: result, strength: 0.6, info: 1.0 }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleActionChange = (newAction: typeof action) => {
    setAction(newAction);
    if (newAction === 'infill' && !model.includes('inpainting')) {
      setModel('nai-diffusion-4-full-inpainting');
    } else if (newAction !== 'infill' && model.includes('inpainting')) {
      setModel('nai-diffusion-4-5-full');
    }
  };

  // ====== 元数据导入处理 ======
  const handleImportFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }
    const { metadata, thumbnail } = await parsePngMetadata(file);
    setImportThumbnail(thumbnail);
    if (metadata) {
      setImportedMeta(metadata);
      setShowImportModal(true);
    } else {
      // 没有找到元数据时也弹窗提示
      setImportedMeta(null);
      setShowImportModal(true);
    }
  };

  const handleApplyMetadata = (meta: PngMetadata) => {
    if (meta.prompt) setPrompt(meta.prompt);
    if (meta.negativePrompt) setNegativePrompt(meta.negativePrompt);
    if (meta.steps) setSteps(meta.steps);
    if (meta.scale) setCfgScale(meta.scale);
    if (meta.seed !== undefined) setSeed(meta.seed);
    if (meta.width) setWidth(meta.width);
    if (meta.height) setHeight(meta.height);
    if (meta.noiseSchedule) setNoiseSchedule(meta.noiseSchedule);
    if (meta.sm !== undefined) setSm(meta.sm);
    if (meta.smDyn !== undefined) setSmDyn(meta.smDyn);
    if (meta.cfgRescale !== undefined) setCfgRescale(meta.cfgRescale);
    if (meta.uncondScale !== undefined) setUncondScale(meta.uncondScale);
    if (meta.sampler) {
      // 尝试匹配采样器名称到内部 ID
      const samplerMap: Record<string, string> = {
        'k_euler': 'k_euler',
        'k_euler_ancestral': 'k_euler_ancestral',
        'k_dpmpp_2s_ancestral': 'k_dpmpp_2s_ancestral',
        'k_dpmpp_2m': 'k_dpmpp_2m',
        'k_dpmpp_sde': 'k_dpmpp_sde',
        'ddim_v3': 'ddim_v3',
        'euler': 'k_euler',
        'euler_ancestral': 'k_euler_ancestral',
        'euler a': 'k_euler_ancestral',
        'dpm++ 2s ancestral': 'k_dpmpp_2s_ancestral',
        'dpm++ 2m': 'k_dpmpp_2m',
        'dpm++ sde': 'k_dpmpp_sde',
        'dpm++ 2m sde': 'k_dpmpp_sde',
        'ddim': 'ddim_v3',
      };
      const key = meta.sampler.toLowerCase();
      setSampler(samplerMap[key] || meta.sampler);
    }
    setShowImportModal(false);
    setImportedMeta(null);
    if (importThumbnail) { URL.revokeObjectURL(importThumbnail); setImportThumbnail(''); }
  };

  const availableModels = action === 'infill' ? INPAINTING_MODELS : MODELS;

  return (
    <div className="min-h-screen bg-[#E8DCC4] text-[#4A3B32] font-serif flex flex-col relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none opacity-[0.04]" style={{ backgroundImage: "url('https://grainy-gradients.vercel.app/noise.svg')" }}></div>
      
      {/* Header */}
      <header className="bg-[#F4EBD0]/90 backdrop-blur-sm border-b-2 border-[#C8B494] p-2 md:p-4 flex justify-between items-center z-10 shadow-sm relative">
        <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-[#8B7355] to-transparent opacity-30"></div>
        <div className="flex items-center gap-2 md:gap-3">
          <div className="bg-[#8B7355] p-1.5 md:p-2 rounded-lg shadow-inner">
            <Feather className="text-[#F4EBD0] w-5 h-5 md:w-6 md:h-6" />
          </div>
          <div>
            <h1 className="text-base md:text-2xl font-bold tracking-wider text-[#5C4A3D]">NovelAI 幻绘工坊</h1>
            <p className="text-[10px] text-[#A68A61] tracking-widest hidden md:block">· PROFESSIONAL EDITION ·</p>
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-3 text-sm font-medium text-[#8B7355]">
          <div className="flex gap-0.5 md:gap-1 bg-[#E8DCC4] p-0.5 md:p-1 rounded-full border border-[#C8B494] shadow-inner">
            {[
              {id: 'generate', label: '文生图'},
              {id: 'img2img', label: '图生图'},
              {id: 'infill', label: '重绘'},
            ].map(a => (
              <button key={a.id} onClick={() => handleActionChange(a.id as any)}
                className={`px-2 md:px-4 py-1 md:py-1.5 text-[10px] md:text-xs font-bold rounded-full transition-all ${action === a.id ? 'bg-[#8B7355] text-white shadow' : 'text-[#8B7355] hover:bg-[#D9C5A0]/50'}`}>
                {a.label}
              </button>
            ))}
          </div>
          <div className="hidden md:flex items-center gap-2 bg-[#E8DCC4] px-4 py-2 rounded-full border border-[#C8B494] shadow-inner">
            <Flame className="w-4 h-4 text-[#D35400]" />
            <span>灵力: 约 {steps * nSamples} 消耗</span>
          </div>
          <div className="flex gap-0.5 bg-[#E8DCC4] p-0.5 rounded-full border border-[#C8B494] shadow-inner">
            <button onClick={() => setApiFormat('novelai')}
              className={`px-2 md:px-3 py-1 text-[10px] md:text-xs font-bold rounded-full transition-all ${apiFormat === 'novelai' ? 'bg-[#8B7355] text-white shadow' : 'text-[#8B7355] hover:bg-[#D9C5A0]/50'}`}>
              NAI
            </button>
            <button onClick={() => setApiFormat('openai')}
              className={`px-2 md:px-3 py-1 text-[10px] md:text-xs font-bold rounded-full transition-all ${apiFormat === 'openai' ? 'bg-[#D35400] text-white shadow' : 'text-[#8B7355] hover:bg-[#D9C5A0]/50'}`}>
              OpenAI
            </button>
            <button onClick={() => setApiFormat('thirdparty')}
              className={`px-2 md:px-3 py-1 text-[10px] md:text-xs font-bold rounded-full transition-all ${apiFormat === 'thirdparty' ? 'bg-[#2563EB] text-white shadow' : 'text-[#8B7355] hover:bg-[#D9C5A0]/50'}`}>
              第三方
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 overflow-hidden h-[calc(100vh-52px)] md:h-[calc(100vh-76px)] max-w-[1800px] mx-auto w-full p-2 md:p-4 gap-2 md:gap-4 relative z-10 pb-16 md:pb-4">
        
        {/* ==================== 左侧边栏 ==================== */}
        <aside className={`${mobilePanel === 'settings' ? 'flex' : 'hidden'} md:flex w-full md:w-[340px] flex-shrink-0 bg-[#FDFBF7] border border-[#D9C5A0] shadow-lg rounded-xl flex-col overflow-y-auto custom-scrollbar relative`}>
          <div className="absolute top-2 left-2 w-3 h-3 border-t border-l border-[#8B7355] opacity-40"></div>
          <div className="absolute top-2 right-2 w-3 h-3 border-t border-r border-[#8B7355] opacity-40"></div>
          
          <div className="p-3 md:p-5 space-y-5 md:space-y-6">
            
            {/* API 设置 */}
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-lg font-bold text-[#5C4A3D] border-b border-[#EADDCA] pb-2">
                <LinkIcon className="w-5 h-5 text-[#A68A61]" /> 魔力源泉 (API)
              </label>
              <div className="space-y-3">
                <div className="relative mt-2">
                  <span className="absolute -top-2.5 left-3 bg-[#FDFBF7] px-1 text-xs text-[#8B7355] font-bold z-10">API 地址</span>
                  <input type="text" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)}
                    placeholder="https://image.novelai.net"
                    className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2.5 text-sm text-[#5C4A3D] focus:border-[#8B7355] outline-none relative z-0" />
                </div>
                <div className="relative mt-2">
                  <span className="absolute -top-2.5 left-3 bg-[#FDFBF7] px-1 text-xs text-[#8B7355] font-bold z-10">API 密钥</span>
                  <input type={showApiKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                    placeholder="pst-..."
                    className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2.5 pr-10 text-sm text-[#5C4A3D] focus:border-[#8B7355] outline-none relative z-0 font-mono" />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#5C4A3D] z-10">
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* 模型选择 */}
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-lg font-bold text-[#5C4A3D] border-b border-[#EADDCA] pb-2">
                <Layers className="w-5 h-5 text-[#A68A61]" /> {apiFormat === 'thirdparty' ? '第三方模型' : '核心模型'}
              </label>
              {apiFormat === 'openai' ? (
                <div className="space-y-2">
                  <select value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)}
                    className="w-full bg-[#F4EBD0] border border-[#C8B494] rounded-lg p-3 text-[#5C4A3D] font-medium shadow-inner text-sm cursor-pointer outline-none">
                    {openaiCustomModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <div className="flex gap-1.5">
                    <input type="text" placeholder="输入模型名称添加..." id="openaiNewModelInput"
                      className="flex-1 bg-[#F4EBD0] border border-[#C8B494] rounded-lg p-2 text-xs text-[#5C4A3D] outline-none placeholder:text-[#C8B494]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const input = e.currentTarget as HTMLInputElement;
                          const val = input.value.trim();
                          if (val && !openaiCustomModels.includes(val)) {
                            setOpenaiCustomModels(prev => [...prev, val]);
                            setOpenaiModel(val);
                            input.value = '';
                          }
                        }
                      }} />
                    <button onClick={() => {
                      const input = document.getElementById('openaiNewModelInput') as HTMLInputElement | null;
                      const val = input ? input.value.trim() : '';
                      if (val && !openaiCustomModels.includes(val)) {
                        setOpenaiCustomModels(prev => [...prev, val]);
                        setOpenaiModel(val);
                        if (input) input.value = '';
                      }
                    }} className="px-2 py-1 bg-[#D35400] text-white rounded-lg text-xs font-bold hover:bg-[#BA4A00] transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    {openaiCustomModels.length > 1 && (
                      <button onClick={() => {
                        if (confirm('删除模型 "' + openaiModel + '"？')) {
                          const next = openaiCustomModels.filter(m => m !== openaiModel);
                          setOpenaiCustomModels(next);
                          setOpenaiModel(next[0] || '');
                        }
                      }} className="px-2 py-1 bg-red-400/80 text-white rounded-lg text-xs font-bold hover:bg-red-500 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-[#8B7355] bg-[#F4EBD0]/60 border border-[#EADDCA] p-2 rounded">
                    OpenAI 兼容格式，可自定义模型名称
                  </p>
                </div>
              ) : apiFormat === 'thirdparty' ? (
                <div className="space-y-2">
                  <select value={thirdpartyModel} onChange={(e) => setThirdpartyModel(e.target.value)}
                    className="w-full bg-[#F4EBD0] border border-[#C8B494] rounded-lg p-3 text-[#5C4A3D] font-medium shadow-inner text-sm cursor-pointer outline-none">
                    {customModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <div className="flex gap-1.5">
                    <input type="text" placeholder="输入模型名称添加..." id="newModelInput"
                      className="flex-1 bg-[#F4EBD0] border border-[#C8B494] rounded-lg p-2 text-xs text-[#5C4A3D] outline-none placeholder:text-[#C8B494]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const input = e.target as HTMLInputElement;
                          const val = input.value.trim();
                          if (val && !customModels.includes(val)) {
                            setCustomModels(prev => [...prev, val]);
                            setThirdpartyModel(val);
                            input.value = '';
                          }
                        }
                      }} />
                    <button onClick={() => {
                      const input = document.getElementById('newModelInput') as HTMLInputElement;
                      const val = input?.value.trim();
                      if (val && !customModels.includes(val)) {
                        setCustomModels(prev => [...prev, val]);
                        setThirdpartyModel(val);
                        input.value = '';
                      }
                    }} className="px-2 py-1 bg-[#8B7355] text-white rounded-lg text-xs font-bold hover:bg-[#5C4A3D] transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    {customModels.length > 1 && (
                      <button onClick={() => {
                        if (confirm(`删除模型 "${thirdpartyModel}"？`)) {
                          const next = customModels.filter(m => m !== thirdpartyModel);
                          setCustomModels(next);
                          setThirdpartyModel(next[0] || '');
                        }
                      }} className="px-2 py-1 bg-red-400/80 text-white rounded-lg text-xs font-bold hover:bg-red-500 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-[#8B7355] bg-[#F4EBD0]/60 border border-[#EADDCA] p-2 rounded">
                    支持 GPT-image、DALL-E、Gemini 等任何兼容 OpenAI 格式的图片生成模型
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <select value={model} onChange={(e) => setModel(e.target.value)}
                    className="w-full bg-[#F4EBD0] border border-[#C8B494] rounded-lg p-3 text-[#5C4A3D] font-medium shadow-inner text-sm cursor-pointer outline-none">
                    {availableModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    {naiCustomModels.filter(m => !availableModels.some(a => a.value === m)).map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <div className="flex gap-1.5">
                    <input type="text" placeholder="输入模型名称添加..." id="naiNewModelInput"
                      className="flex-1 bg-[#F4EBD0] border border-[#C8B494] rounded-lg p-2 text-xs text-[#5C4A3D] outline-none placeholder:text-[#C8B494]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const input = e.currentTarget as HTMLInputElement;
                          const val = input.value.trim();
                          if (val && !naiCustomModels.includes(val) && !availableModels.some(a => a.value === val)) {
                            setNaiCustomModels(prev => [...prev, val]);
                            setModel(val);
                            input.value = '';
                          }
                        }
                      }} />
                    <button onClick={() => {
                      const input = document.getElementById('naiNewModelInput') as HTMLInputElement | null;
                      const val = input ? input.value.trim() : '';
                      if (val && !naiCustomModels.includes(val) && !availableModels.some(a => a.value === val)) {
                        setNaiCustomModels(prev => [...prev, val]);
                        setModel(val);
                        if (input) input.value = '';
                      }
                    }} className="px-2 py-1 bg-[#8B7355] text-white rounded-lg text-xs font-bold hover:bg-[#5C4A3D] transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    {naiCustomModels.length > 0 && (
                      <button onClick={() => {
                        if (confirm('删除模型 "' + model + '"？')) {
                          const next = naiCustomModels.filter(m => m !== model);
                          setNaiCustomModels(next);
                          setModel(availableModels[0].value);
                        }
                      }} className="px-2 py-1 bg-red-400/80 text-white rounded-lg text-xs font-bold hover:bg-red-500 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {isV4Model && <p className="text-[10px] text-[#8B7355] bg-[#F4EBD0]/60 border border-[#EADDCA] p-2 rounded">V4+ 已启用多角色与官方坐标系</p>}
                </div>
              )}
            </div>

            {/* 纸张尺寸 */}
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[#EADDCA] pb-2">
                <label className="flex items-center gap-2 text-lg font-bold text-[#5C4A3D]">
                  <ImageIcon className="w-5 h-5 text-[#A68A61]" /> 纸张尺寸
                </label>
                <span className="text-xs font-mono bg-[#E8DCC4] px-1.5 py-0.5 rounded text-[#8B7355] border border-[#D9C5A0]">{width}×{height}</span>
              </div>
              
              <div className="grid grid-cols-3 gap-2">
                {[
                  {w:832, h:1216, l:'竖图'},
                  {w:1024, h:1024, l:'方图'},
                  {w:1216, h:832, l:'横图'},
                ].map(r => (
                  <button key={r.l} onClick={() => {setWidth(r.w); setHeight(r.h)}} 
                    className={`text-xs py-2 rounded-lg border transition-colors ${width === r.w && height === r.h ? 'bg-[#8B7355] text-white border-transparent shadow' : 'bg-[#F4EBD0] text-[#5C4A3D] border-[#C8B494] hover:bg-[#EADDCA]'}`}>
                    {r.l}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="relative">
                  <span className="absolute -top-2.5 left-2 bg-[#FDFBF7] px-1 text-[10px] text-[#8B7355] font-bold z-10">宽</span>
                  <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} step="64" min="64" max="1024"
                    className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2 text-sm outline-none relative z-0" />
                </div>
                <div className="relative">
                  <span className="absolute -top-2.5 left-2 bg-[#FDFBF7] px-1 text-[10px] text-[#8B7355] font-bold z-10">高</span>
                  <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} step="64" min="64" max="1024"
                    className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2 text-sm outline-none relative z-0" />
                </div>
              </div>
            </div>

            {/* 细节调校 */}
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-lg font-bold text-[#5C4A3D] border-b border-[#EADDCA] pb-2">
                <Settings2 className="w-5 h-5 text-[#A68A61]" /> 细节调校
              </label>
              
              <div className="bg-[#F4EBD0] p-3 rounded-lg border border-[#D9C5A0] shadow-inner">
                <div className="flex justify-between mb-2">
                  <span className="text-xs font-bold text-[#5C4A3D]">步数 (Steps)</span>
                  <span className="text-xs font-mono bg-[#FDFBF7] px-1 border border-[#C8B494] rounded text-[#8B7355]">{steps}</span>
                </div>
                <input type="range" min="1" max="50" value={steps} onChange={(e) => setSteps(Number(e.target.value))} className="w-full accent-[#D35400] h-1.5 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
              </div>

              <div className="bg-[#F4EBD0] p-3 rounded-lg border border-[#D9C5A0] shadow-inner">
                <div className="flex justify-between mb-2">
                  <span className="text-xs font-bold text-[#5C4A3D]">服从度 (CFG)</span>
                  <span className="text-xs font-mono bg-[#FDFBF7] px-1 border border-[#C8B494] rounded text-[#8B7355]">{cfgScale}</span>
                </div>
                <input type="range" min="0" max="10" step="0.1" value={cfgScale} onChange={(e) => setCfgScale(Number(e.target.value))} className="w-full accent-[#D35400] h-1.5 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
              </div>

              <div className="bg-[#F4EBD0] p-3 rounded-lg border border-[#D9C5A0] shadow-inner">
                <div className="flex justify-between mb-2">
                  <span className="text-xs font-bold text-[#5C4A3D]">批量张数</span>
                  <span className="text-xs font-mono bg-[#FDFBF7] px-1 border border-[#C8B494] rounded text-[#8B7355]">{nSamples}</span>
                </div>
                <input type="range" min="1" max="4" value={nSamples} onChange={(e) => setNSamples(Number(e.target.value))} className="w-full accent-[#D35400] h-1.5 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
              </div>

              <div className="relative mt-2">
                <span className="absolute -top-2.5 left-3 bg-[#FDFBF7] px-1 text-xs text-[#8B7355] font-bold z-10">采样器</span>
                <select value={sampler} onChange={(e) => setSampler(e.target.value)} className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2.5 text-sm outline-none cursor-pointer">
                  {SAMPLERS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>

              <div className="relative mt-2">
                <span className="absolute -top-2.5 left-3 bg-[#FDFBF7] px-1 text-xs text-[#8B7355] font-bold z-10">UC 预设</span>
                <select value={ucPreset} onChange={(e) => setUcPreset(Number(e.target.value))} className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2.5 text-sm outline-none cursor-pointer">
                  {UC_PRESETS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
              </div>

              <div className="flex gap-2 relative mt-3">
                <div className="flex-1 relative">
                  <span className="absolute -top-2.5 left-3 bg-[#FDFBF7] px-1 text-xs text-[#8B7355] font-bold z-10">种子 (0=随机)</span>
                  <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} max="4294967295"
                    className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2.5 text-sm outline-none font-mono relative z-0" />
                </div>
                <button onClick={() => setSeed(Math.floor(Math.random() * 4294967295))} className="p-2.5 bg-[#F4EBD0] border border-[#C8B494] hover:bg-[#EADDCA] rounded-lg transition-colors">
                  <RefreshCw className="w-5 h-5 text-[#8B7355]" />
                </button>
              </div>
            </div>

            {/* 高级参数折叠 */}
            <div>
              <button onClick={() => setShowAdvanced(!showAdvanced)} className="w-full flex items-center justify-between gap-2 text-lg font-bold text-[#5C4A3D] border-b border-[#EADDCA] pb-2 hover:text-[#8B7355] transition-colors">
                <span className="flex items-center gap-2"><Paintbrush className="w-5 h-5 text-[#A68A61]" /> 炼金秘术 (高级)</span>
                {showAdvanced ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </button>
              
              {showAdvanced && (
                <div className="mt-4 space-y-4">
                  <div className="relative">
                    <span className="absolute -top-2.5 left-3 bg-[#FDFBF7] px-1 text-xs text-[#8B7355] font-bold z-10">噪声调度</span>
                    <select value={noiseSchedule} onChange={(e) => setNoiseSchedule(e.target.value)} className="w-full bg-transparent border-2 border-[#EADDCA] rounded-lg p-2.5 text-sm outline-none cursor-pointer">
                      {NOISE_SCHEDULES.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                    </select>
                  </div>

                  <div className="bg-[#F4EBD0] p-3 rounded-lg border border-[#D9C5A0] shadow-inner">
                    <div className="flex justify-between mb-2">
                      <span className="text-xs font-bold text-[#5C4A3D]">CFG 重缩放</span>
                      <span className="text-xs font-mono bg-[#FDFBF7] px-1 border border-[#C8B494] rounded text-[#8B7355]">{cfgRescale}</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.01" value={cfgRescale} onChange={(e) => setCfgRescale(Number(e.target.value))} className="w-full accent-[#D35400] h-1.5 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
                  </div>

                  <div className="bg-[#F4EBD0] p-3 rounded-lg border border-[#D9C5A0] shadow-inner">
                    <div className="flex justify-between mb-2">
                      <span className="text-xs font-bold text-[#5C4A3D]">无条件尺度</span>
                      <span className="text-xs font-mono bg-[#FDFBF7] px-1 border border-[#C8B494] rounded text-[#8B7355]">{uncondScale}</span>
                    </div>
                    <input type="range" min="0" max="1.5" step="0.05" value={uncondScale} onChange={(e) => setUncondScale(Number(e.target.value))} className="w-full accent-[#D35400] h-1.5 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
                  </div>

                  <div className="space-y-2">
                    {[
                      { state: qualityToggle, setter: setQualityToggle, label: '自动质量标签', desc: '添加 masterpiece 等' },
                      { state: sm, setter: setSm, label: 'SMEA 采样', desc: '改善大图质量' },
                      { state: smDyn, setter: setSmDyn, label: 'SMEA 动态', desc: '更强自适应调节' },
                      { state: decrisper, setter: setDecrisper, label: 'Decrisper', desc: '减少过曝与色彩失真' },
                      { state: varietyBoost, setter: setVarietyBoost, label: 'Variety+ 多样性', desc: '增强结果多样性' },
                    ].map((t, i) => (
                      <label key={i} className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-colors ${t.state ? 'bg-[#D35400]/10 border-[#D35400]/30' : 'bg-[#F4EBD0]/40 border-[#EADDCA] hover:bg-[#F4EBD0]'}`}>
                        <div>
                          <div className="text-xs font-bold text-[#5C4A3D]">{t.label}</div>
                          <div className="text-[10px] text-[#A68A61]">{t.desc}</div>
                        </div>
                        <div className="relative">
                          <input type="checkbox" checked={t.state} onChange={(e) => t.setter(e.target.checked)} className="sr-only peer" />
                          <div className="w-10 h-5 bg-[#C8B494] peer-checked:bg-[#D35400] rounded-full transition-colors"></div>
                          <div className={`absolute top-0.5 left-0.5 bg-white w-4 h-4 rounded-full transition-transform ${t.state ? 'translate-x-5' : ''}`}></div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>
        </aside>

        {/* ==================== 中间栏 ==================== */}
        <div className={`${mobilePanel === 'prompts' ? 'flex' : 'hidden'} md:flex flex-1 flex-col gap-2 md:gap-3 min-w-0 md:min-w-[450px]`}>
          
          <div className="flex gap-1 md:gap-1.5 p-1 md:p-1.5 bg-[#EADDCA] rounded-xl shadow-inner border border-[#D9C5A0]">
            {[
              { id: 'prompts', icon: Scroll, label: '咒语', labelFull: '基础咒语' },
              { id: 'characters', icon: Users, label: `角色${characters.length > 0 ? `(${characters.length})` : ''}`, labelFull: `多角色 ${characters.length > 0 ? `(${characters.length})` : ''}` },
              { id: 'vibe', icon: Sparkles, label: `氛围${vibes.length > 0 ? `(${vibes.length})` : ''}`, labelFull: `氛围共鸣 ${vibes.length > 0 ? `(${vibes.length})` : ''}` },
              { id: 'img2img', icon: ImagePlus, label: action === 'infill' ? '重绘' : '图生图', labelFull: action === 'infill' ? '局部重绘' : '图生图' }
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
                className={`flex-1 flex items-center justify-center gap-1 md:gap-2 py-2 md:py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all ${activeTab === tab.id ? 'bg-[#FDFBF7] text-[#8B7355] shadow-md border border-[#D9C5A0]' : 'text-[#8B7355]/70 hover:bg-[#F4EBD0]/50 hover:text-[#8B7355]'}`}>
                <tab.icon className="w-4 h-4" /> <span className="md:hidden">{tab.label}</span><span className="hidden md:inline">{tab.labelFull}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 bg-[#FDFBF7] border border-[#D9C5A0] shadow-md rounded-xl p-3 md:p-5 overflow-y-auto custom-scrollbar">
            
            {activeTab === 'prompts' && (
              <div className="space-y-5">
                <div className="bg-[#F4EBD0]/50 p-4 rounded-xl border border-[#EADDCA]">
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-sm font-bold text-[#5C4A3D]">质量修饰词</label>
                    <label className="flex items-center gap-2 text-xs text-[#8B7355] cursor-pointer">
                      <span>自动附加</span>
                      <div className="relative">
                        <input type="checkbox" checked={qualityToggle} onChange={(e) => setQualityToggle(e.target.checked)} className="sr-only peer" />
                        <div className="w-8 h-4 bg-[#C8B494] peer-checked:bg-[#D35400] rounded-full transition-colors"></div>
                        <div className={`absolute top-0.5 left-0.5 bg-white w-3 h-3 rounded-full transition-transform ${qualityToggle ? 'translate-x-4' : ''}`}></div>
                      </div>
                    </label>
                  </div>
                  <input type="text" value={qualityPrompt} onChange={(e) => setQualityPrompt(e.target.value)} 
                    className="w-full bg-transparent border-b border-[#C8B494] p-1 text-sm text-[#8B7355] outline-none disabled:opacity-50" 
                    disabled={!qualityToggle} />
                  <p className="text-[10px] text-[#A68A61] mt-1">仅填画质词，人物特征请写在下方</p>
                </div>
                
                <div>
                  <label className="text-sm font-bold text-[#5C4A3D] mb-2 flex items-center gap-2"><Scroll className="w-4 h-4" /> 场景/人物 (Base Prompt)</label>
                  <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} 
                    className="w-full h-32 bg-[#F4EBD0]/20 border-2 border-[#EADDCA] rounded-xl p-4 text-sm resize-none focus:border-[#8B7355] outline-none leading-relaxed" 
                    placeholder="⚠️ 必须指定性别：1girl / 1boy ..." />
                  <p className="text-[10px] text-[#D35400] mt-1">⚠️ NovelAI 默认偏向女性，男性角色请使用 1boy / male focus</p>
                </div>

                <div>
                  <label className="text-sm font-bold text-[#8A4A43] mb-2 flex items-center gap-2"><Hash className="w-4 h-4" /> 禁忌烙印 (Negative Prompt)</label>
                  <textarea value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} 
                    className="w-full h-24 bg-[#F9F0ED]/50 border-2 border-[#E8C8C2] rounded-xl p-4 text-sm resize-none focus:border-[#C1827A] outline-none text-[#8A4A43] leading-relaxed" />
                </div>
              </div>
            )}

            {activeTab === 'characters' && (
              <div className="space-y-4">
                <div className={`p-4 rounded-xl border text-sm mb-4 ${isV4Model ? 'bg-[#F4EBD0]/50 border-[#EADDCA] text-[#8B7355]' : 'bg-red-50 border-red-200 text-red-700'}`}>
                  {isV4Model 
                    ? '💡 基础提示词写场景和人数（如 2girls），这里填每个角色外观。动作前缀：source#hug / target#hug / mutual#dance'
                    : '⚠️ 多角色功能仅在 V4+ 模型中可用，请在左侧切换到 V4 或 V4.5 模型。'}
                </div>
                
                {characters.map((char, index) => (
                  <div key={index} className="bg-white border-2 border-[#EADDCA] rounded-xl p-4 relative shadow-sm">
                    <div className="flex justify-between items-center mb-3">
                      <div className="flex items-center gap-3">
                        <span className="bg-[#8B7355] text-white text-xs font-bold px-2 py-1 rounded">角色 {index + 1}</span>
                        <div className="flex gap-1 bg-[#F4EBD0] p-1 rounded-lg border border-[#C8B494]">
                          {[
                            { v: 'female', l: '♀', t: '女性 (girl)' },
                            { v: 'male', l: '♂', t: '男性 (boy)' },
                            { v: 'other', l: '○', t: '其他 (other)' },
                          ].map(g => (
                            <button key={g.v} title={g.t}
                              onClick={() => {
                                const nc = [...characters];
                                nc[index].gender = g.v as any;
                                setCharacters(nc);
                              }}
                              className={`w-7 h-7 text-sm rounded transition-colors ${char.gender === g.v ? 'bg-[#8B7355] text-white shadow' : 'text-[#8B7355] hover:bg-[#E8DCC4]'}`}>
                              {g.l}
                            </button>
                          ))}
                        </div>
                      </div>
                      <button onClick={() => setCharacters(characters.filter((_, i) => i !== index))} className="text-[#C8B494] hover:text-[#D35400] p-1">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_160px] gap-4">
                      <div className="space-y-2">
                        <div>
                          <label className="text-[10px] font-bold text-[#A68A61] mb-1 block">正向提示词</label>
                          <textarea value={char.prompt} 
                            onChange={(e) => {
                              const nc = [...characters];
                              nc[index].prompt = e.target.value;
                              setCharacters(nc);
                            }}
                            className="w-full h-16 bg-transparent border border-[#EADDCA] rounded-lg p-2 text-sm resize-none focus:border-[#8B7355] outline-none" 
                            placeholder="purple hair, red eyes, school uniform..." />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-[#C1827A] mb-1 block">负面提示词 (UC)</label>
                          <textarea value={char.uc}
                            onChange={(e) => {
                              const nc = [...characters];
                              nc[index].uc = e.target.value;
                              setCharacters(nc);
                            }}
                            className="w-full h-10 bg-[#F9F0ED]/50 border border-[#E8C8C2] rounded-lg p-2 text-xs resize-none focus:border-[#C1827A] outline-none text-[#8A4A43]" 
                            placeholder="该角色不想要的特征..." />
                        </div>
                      </div>
                      
                      <div>
                        <label className="text-[10px] font-bold text-[#A68A61] mb-1 block">画布位置</label>
                        <div className="bg-[#E8DCC4] p-1.5 rounded-lg border border-[#C8B494]">
                          <button 
                            onClick={() => {
                              const nc = [...characters];
                              nc[index].position = 'AI Choice';
                              setCharacters(nc);
                            }}
                            className={`w-full text-[10px] py-1 mb-1 rounded transition-colors ${char.position === 'AI Choice' ? 'bg-[#8B7355] text-white font-bold' : 'bg-[#FDFBF7] text-[#8B7355] hover:bg-[#D9C5A0]'}`}>
                            AI 自动
                          </button>
                          <div className="grid grid-cols-5 gap-0.5 aspect-square">
                            {['1','2','3','4','5'].map(row =>
                              ['A','B','C','D','E'].map(col => {
                                const pos = `${col}${row}`;
                                const isSelected = char.position === pos;
                                return (
                                  <button key={pos}
                                    onClick={() => {
                                      const nc = [...characters];
                                      nc[index].position = pos;
                                      setCharacters(nc);
                                    }}
                                    className={`text-[8px] flex items-center justify-center rounded transition-all ${isSelected ? 'bg-[#D35400] text-white font-bold shadow' : 'bg-[#FDFBF7] text-[#8B7355] hover:bg-[#D9C5A0]'}`}
                                    title={pos}>
                                    {pos}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                
                <button onClick={() => setCharacters([...characters, { prompt: '', uc: '', gender: 'female', position: 'AI Choice' }])} 
                  disabled={characters.length >= 6 || !isV4Model} 
                  className="w-full py-4 border-2 border-dashed border-[#C8B494] text-[#8B7355] rounded-xl font-bold hover:bg-[#F4EBD0] transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                  <Plus className="w-5 h-5" /> 召唤新角色 ({characters.length}/6)
                </button>
              </div>
            )}

            {activeTab === 'vibe' && (
              <div className="space-y-4">
                <div className="bg-[#F4EBD0]/50 p-4 rounded-xl border border-[#EADDCA] text-sm text-[#8B7355]">
                  💡 上传参考图，AI 将汲取其画风与氛围特征。最多 16 张。
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {vibes.map((vibe, index) => (
                    <div key={index} className="border-2 border-[#EADDCA] rounded-xl overflow-hidden relative shadow-sm">
                      <button onClick={() => setVibes(vibes.filter((_, i) => i !== index))} className="absolute top-2 right-2 bg-black/60 text-white p-1.5 rounded-full z-10 hover:bg-red-500">
                        <X className="w-3 h-3" />
                      </button>
                      <div className="h-32 bg-black">
                        <img src={vibe.image} alt="vibe" className="w-full h-full object-cover" />
                      </div>
                      <div className="p-3 bg-[#FDFBF7] space-y-3 border-t border-[#EADDCA]">
                        <div>
                          <label className="text-[11px] font-bold text-[#8B7355] flex justify-between mb-1">强度 <span className="font-mono">{vibe.strength.toFixed(2)}</span></label>
                          <input type="range" min="0" max="1" step="0.05" value={vibe.strength} 
                            onChange={(e) => {
                              const nv = [...vibes]; nv[index].strength = Number(e.target.value); setVibes(nv);
                            }}
                            className="w-full accent-[#8B7355] h-1.5 bg-[#EADDCA] rounded-lg appearance-none" />
                        </div>
                        <div>
                          <label className="text-[11px] font-bold text-[#8B7355] flex justify-between mb-1">信息提取 <span className="font-mono">{vibe.info.toFixed(2)}</span></label>
                          <input type="range" min="0" max="1" step="0.05" value={vibe.info}
                            onChange={(e) => {
                              const nv = [...vibes]; nv[index].info = Number(e.target.value); setVibes(nv);
                            }}
                            className="w-full accent-[#8B7355] h-1.5 bg-[#EADDCA] rounded-lg appearance-none" />
                        </div>
                      </div>
                    </div>
                  ))}

                  {vibes.length < 16 && (
                    <button onClick={() => vibeFileRef.current?.click()} className="border-2 border-dashed border-[#C8B494] rounded-xl h-[240px] flex flex-col items-center justify-center text-[#8B7355] hover:bg-[#F4EBD0] transition-colors gap-3">
                      <Upload className="w-8 h-8 opacity-60" />
                      <span className="font-bold">注入氛围画卷</span>
                      <span className="text-xs">({vibes.length}/16)</span>
                    </button>
                  )}
                  <input type="file" ref={vibeFileRef} onChange={(e) => handleImageUpload(e, 'vibe')} accept="image/*" className="hidden" />
                </div>
              </div>
            )}

            {activeTab === 'img2img' && (
              <div className="space-y-4 h-full flex flex-col">
                <div className="bg-[#F4EBD0]/50 p-4 rounded-xl border border-[#EADDCA] text-sm text-[#8B7355]">
                  {action === 'infill' 
                    ? '🖌️ 局部重绘：上传底图和蒙版（白色区域将被重绘）。' 
                    : action === 'img2img'
                      ? '🖼️ 图生图：AI 将在底图基础上进行幻化重绘。'
                      : '💡 请先在顶部切换到「图生图」或「局部重绘」模式。'}
                </div>

                {action !== 'generate' && (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-bold text-[#A68A61] mb-2 block">底图 (Base Image)</label>
                        <div className="border-2 border-dashed border-[#C8B494] rounded-xl flex items-center justify-center bg-[#E8DCC4]/30 relative overflow-hidden min-h-[200px]">
                          {baseImage ? (
                            <>
                              <img src={baseImage} alt="base" className="max-w-full max-h-full object-contain" />
                              <button onClick={() => setBaseImage(null)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white p-1.5 rounded-full shadow">
                                <X className="w-3 h-3" />
                              </button>
                            </>
                          ) : (
                            <label className="flex flex-col items-center justify-center w-full h-full cursor-pointer p-4">
                              <ImagePlus className="w-8 h-8 text-[#C8B494] mb-2" />
                              <span className="font-bold text-[#8B7355] text-sm">上传底图</span>
                              <input type="file" onChange={(e) => handleImageUpload(e, 'img2img')} accept="image/*" className="hidden" />
                            </label>
                          )}
                        </div>
                      </div>

                      {action === 'infill' && (
                        <div>
                          <label className="text-xs font-bold text-[#A68A61] mb-2 block">蒙版 (Mask)</label>
                          <div className="border-2 border-dashed border-[#C8B494] rounded-xl flex items-center justify-center bg-[#E8DCC4]/30 relative overflow-hidden min-h-[200px]">
                            {maskImage ? (
                              <>
                                <img src={maskImage} alt="mask" className="max-w-full max-h-full object-contain" />
                                <button onClick={() => setMaskImage(null)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white p-1.5 rounded-full shadow">
                                  <X className="w-3 h-3" />
                                </button>
                              </>
                            ) : (
                              <label className="flex flex-col items-center justify-center w-full h-full cursor-pointer p-4">
                                <Paintbrush className="w-8 h-8 text-[#C8B494] mb-2" />
                                <span className="font-bold text-[#8B7355] text-sm">上传蒙版</span>
                                <input type="file" onChange={(e) => handleImageUpload(e, 'mask')} accept="image/*" className="hidden" />
                              </label>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {action === 'img2img' && baseImage && (
                      <div className="bg-[#F4EBD0] p-5 rounded-xl border border-[#D9C5A0] space-y-4 shadow-inner">
                        <div>
                          <div className="flex justify-between mb-2">
                            <label className="text-sm font-bold text-[#5C4A3D]">变化强度 (Strength)</label>
                            <span className="text-sm font-mono text-[#8B7355] bg-[#FDFBF7] px-2 py-0.5 rounded border border-[#C8B494]">{imgStrength.toFixed(2)}</span>
                          </div>
                          <input type="range" min="0.01" max="0.99" step="0.01" value={imgStrength} onChange={(e) => setImgStrength(Number(e.target.value))} className="w-full accent-[#D35400] h-2 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
                        </div>
                        <div>
                          <div className="flex justify-between mb-2">
                            <label className="text-sm font-bold text-[#5C4A3D]">噪声量 (Noise)</label>
                            <span className="text-sm font-mono text-[#8B7355] bg-[#FDFBF7] px-2 py-0.5 rounded border border-[#C8B494]">{imgNoise.toFixed(2)}</span>
                          </div>
                          <input type="range" min="0" max="1" step="0.01" value={imgNoise} onChange={(e) => setImgNoise(Number(e.target.value))} className="w-full accent-[#D35400] h-2 bg-[#EADDCA] rounded-lg appearance-none cursor-pointer" />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2 md:gap-3 flex-wrap md:flex-nowrap">
            <button onClick={() => importFileRef.current?.click()} className="py-2 md:py-3 px-3 md:px-4 rounded-xl font-bold flex items-center justify-center gap-2 text-xs md:text-sm bg-[#FDFBF7] text-[#8B7355] border-2 border-[#C8B494] hover:bg-[#F4EBD0] transition-colors shadow-sm">
              <FileUp className="w-4 h-4" /> <span className="hidden md:inline">导入</span>元数据
            </button>
            <input type="file" ref={importFileRef} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} accept="image/png,image/webp,image/jpeg" className="hidden" />
            <button onClick={() => setShowPreview(true)} className="py-2 md:py-3 px-3 md:px-4 rounded-xl font-bold flex items-center justify-center gap-2 text-xs md:text-sm bg-[#FDFBF7] text-[#8B7355] border-2 border-[#C8B494] hover:bg-[#F4EBD0] transition-colors shadow-sm">
              <Code className="w-4 h-4" /> <span className="hidden md:inline">预览</span> JSON
            </button>
            <button onClick={handleGenerateRegex} className="py-2 md:py-3 px-3 md:px-4 rounded-xl font-bold flex items-center justify-center gap-2 text-xs md:text-sm bg-[#E8DCC4] text-[#8B7355] border-2 border-[#C8B494] hover:bg-[#D9C5A0] transition-colors shadow-sm">
              <Download className="w-4 h-4" /> <span className="hidden md:inline">生成</span>正则
            </button>
            <button onClick={handleGenerate} disabled={isGenerating}
              className={`flex-1 py-2 md:py-3 rounded-xl font-bold flex items-center justify-center gap-2 md:gap-3 text-sm md:text-lg transition-all shadow-lg border
                ${isGenerating ? 'bg-[#EADDCA] text-[#8B7355] cursor-not-allowed border-[#C8B494]' : 'bg-gradient-to-b from-[#E67E22] to-[#D35400] text-[#FDFBF7] border-[#A04000] hover:shadow-xl hover:-translate-y-0.5 hover:from-[#D35400] hover:to-[#BA4A00]'}`}>
              {isGenerating ? <><RefreshCw className="w-5 h-5 animate-spin" /> <span className="hidden md:inline">正在具现化...</span><span className="md:hidden">生成中...</span></> : <><Wand2 className="w-5 h-5" /> <span className="hidden md:inline">注入灵力，开始生成</span><span className="md:hidden">生成</span></>}
            </button>
          </div>
        </div>

        {/* ==================== 右侧显影区 ==================== */}
        <aside className={`${mobilePanel === 'results' ? 'flex' : 'hidden'} md:flex w-full md:w-[400px] flex-shrink-0 bg-[#FDFBF7] border-2 border-dashed border-[#C8B494] rounded-xl flex-col relative overflow-hidden shadow-inner`}>
          <div className="absolute inset-0 bg-[#F4EBD0] opacity-30 pointer-events-none"></div>

          {/* 标签切换: 当前结果 / 历史画廊 */}
          <div className="flex gap-1 p-1.5 bg-[#EADDCA] border-b border-[#D9C5A0] z-20 relative">
            <button onClick={() => setResultTab('current')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all ${resultTab === 'current' ? 'bg-[#FDFBF7] text-[#D35400] shadow-md border border-[#D9C5A0]' : 'text-[#8B7355]/70 hover:bg-[#F4EBD0]/50'}`}>
              <Sparkles className="w-3.5 h-3.5" /> 当前结果
              {resultImages.length > 0 && <span className="bg-[#D35400] text-white text-[9px] px-1.5 rounded-full">{resultImages.length}</span>}
            </button>
            <button onClick={() => setResultTab('gallery')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all ${resultTab === 'gallery' ? 'bg-[#FDFBF7] text-[#D35400] shadow-md border border-[#D9C5A0]' : 'text-[#8B7355]/70 hover:bg-[#F4EBD0]/50'}`}>
              <Archive className="w-3.5 h-3.5" /> 历史画廊
              {savedImages.length > 0 && <span className="bg-[#8B7355] text-white text-[9px] px-1.5 rounded-full">{savedImages.length}</span>}
            </button>
          </div>

          {/* ===== 当前结果 Tab ===== */}
          {resultTab === 'current' && (
            <>
              {/* 正在生成 */}
              {isGenerating && (
                <div className="flex-1 flex flex-col items-center justify-center z-10 p-6 gap-4">
                  <div className="w-24 h-24 bg-[#E8DCC4] rounded-full flex items-center justify-center border-4 border-[#FDFBF7] shadow-lg">
                    <RefreshCw className="w-10 h-10 text-[#D35400] animate-spin" />
                  </div>
                  <h3 className="text-[#5C4A3D] font-bold text-xl tracking-widest">正在具现化...</h3>
                  <p className="text-[#8B7355] text-sm text-center">请稍候，魔力正在注入画布</p>
                  <div className="w-full max-w-xs bg-[#E8DCC4] rounded-full h-2 overflow-hidden border border-[#D9C5A0]">
                    <div className="h-full bg-gradient-to-r from-[#E67E22] to-[#D35400] animate-pulse" style={{ width: '60%' }}></div>
                  </div>
                </div>
              )}

              {/* 错误提示 */}
              {!isGenerating && errorMsg && (
                <div className="flex-1 flex flex-col items-center justify-center z-10 p-6 gap-3">
                  <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center border-4 border-[#FDFBF7] shadow-lg">
                    <X className="w-8 h-8 text-red-500" />
                  </div>
                  <h3 className="text-red-700 font-bold text-lg">施法失败</h3>
                  <p className="text-red-600 text-xs text-center bg-red-50 p-3 rounded-lg border border-red-200 max-w-full break-words">
                    {errorMsg}
                  </p>
                  <button onClick={() => setErrorMsg('')} className="text-xs text-[#8B7355] underline hover:text-[#5C4A3D]">
                    关闭
                  </button>
                </div>
              )}

              {/* 生成结果 */}
              {!isGenerating && !errorMsg && resultImages.length > 0 && (
                <div className="flex-1 flex flex-col z-10 p-4 gap-3 overflow-y-auto custom-scrollbar">
                  <div className="flex justify-between items-center">
                    <h3 className="text-[#5C4A3D] font-bold text-sm flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-[#D35400]" /> 
                      生成结果 ({resultImages.length} 张)
                    </h3>
                    <button onClick={() => setResultImages([])} className="text-xs text-[#8B7355] hover:text-[#D35400]">
                      清空
                    </button>
                  </div>
                  <div className={resultImages.length === 1 ? '' : 'grid grid-cols-2 gap-2'}>
                    {resultImages.map((img, i) => (
                      <div key={i} className="relative group bg-white border-2 border-[#D9C5A0] rounded-lg overflow-hidden shadow-md">
                        <img src={img} alt={`生成 ${i+1}`} className="w-full h-auto object-contain" />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                          <button onClick={() => handleDownloadImage(img, i)} className="bg-[#D35400] hover:bg-[#BA4A00] text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 shadow">
                            <Download className="w-3 h-3" /> 下载
                          </button>
                          <a href={img} target="_blank" rel="noopener noreferrer" className="bg-[#8B7355] hover:bg-[#5C4A3D] text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 shadow">
                            <Eye className="w-3 h-3" /> 查看
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-[#A68A61] text-center">图片已自动保存到历史画廊</p>
                </div>
              )}

              {/* 默认占位 */}
              {!isGenerating && !errorMsg && resultImages.length === 0 && (
                <div className="flex-1 flex items-center justify-center z-10">
                  <div className="text-center p-6 flex flex-col items-center">
                    <div className="w-24 h-24 bg-[#E8DCC4] rounded-full flex items-center justify-center mb-6 border-4 border-[#FDFBF7] shadow-lg">
                      <Sparkles className="w-10 h-10 text-[#C8B494]" />
                    </div>
                    <h3 className="text-[#5C4A3D] font-bold text-2xl mb-4 tracking-widest">魔法显影区</h3>
                    <p className="text-[#8B7355] text-sm leading-relaxed max-w-[250px] mb-4">
                      铺展卷轴，研磨墨水。<br/>吟唱咒语，静候降临。
                    </p>
                    <div className="text-[10px] text-[#A68A61] space-y-1 bg-[#E8DCC4]/50 p-3 rounded-lg border border-[#D9C5A0] w-full">
                      <div className="flex justify-between"><span>模式:</span><span className="font-mono text-[#5C4A3D]">{action}</span></div>
                      <div className="flex justify-between"><span>模型:</span><span className="font-mono text-[#5C4A3D] truncate max-w-[180px]">{model}</span></div>
                      <div className="flex justify-between"><span>采样:</span><span className="font-mono text-[#5C4A3D]">{sampler}</span></div>
                      <div className="flex justify-between"><span>角色数:</span><span className="font-mono text-[#5C4A3D]">{isV4Model ? characters.length : '— (非V4)'}</span></div>
                      <div className="flex justify-between"><span>氛围参考:</span><span className="font-mono text-[#5C4A3D]">{vibes.length}</span></div>
                      <div className="flex justify-between"><span>批量:</span><span className="font-mono text-[#5C4A3D]">{nSamples} 张</span></div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ===== 历史画廊 Tab ===== */}
          {resultTab === 'gallery' && (
            <div className="flex-1 flex flex-col z-10 overflow-hidden">
              {savedImages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center p-6 flex flex-col items-center">
                    <div className="w-20 h-20 bg-[#E8DCC4] rounded-full flex items-center justify-center mb-4 border-4 border-[#FDFBF7] shadow-lg">
                      <Archive className="w-8 h-8 text-[#C8B494]" />
                    </div>
                    <h3 className="text-[#5C4A3D] font-bold text-lg mb-2">画廊空空如也</h3>
                    <p className="text-[#8B7355] text-xs">生成的图片将自动保存在此</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-center px-4 py-2 border-b border-[#EADDCA]">
                    <span className="text-xs text-[#8B7355] font-bold">{savedImages.length} 张作品</span>
                    <button onClick={async () => {
                      if (confirm('确定清空所有历史图片？此操作不可撤销。')) {
                        await dbClearAll();
                        setSavedImages([]);
                      }
                    }} className="text-[10px] text-red-400 hover:text-red-600 font-bold">
                      清空全部
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
                    <div className="grid grid-cols-2 gap-2">
                      {savedImages.map((item) => (
                        <div key={item.id} className="relative group bg-white border border-[#D9C5A0] rounded-lg overflow-hidden shadow-sm">
                          <img src={item.image} alt="saved" className="w-full h-auto object-contain" />
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1.5 p-2">
                            <button onClick={() => setPreviewImage(item)} className="bg-[#8B7355] hover:bg-[#5C4A3D] text-white px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1 w-full justify-center">
                              <Eye className="w-3 h-3" /> 详情
                            </button>
                            <button onClick={() => handleDownloadImage(item.image, 0)} className="bg-[#D35400] hover:bg-[#BA4A00] text-white px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1 w-full justify-center">
                              <Download className="w-3 h-3" /> 下载
                            </button>
                            <button onClick={async () => {
                              await dbDeleteImage(item.id);
                              setSavedImages(prev => prev.filter(x => x.id !== item.id));
                            }} className="bg-red-500/80 hover:bg-red-600 text-white px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1 w-full justify-center">
                              <Trash2 className="w-3 h-3" /> 删除
                            </button>
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 bg-black/40 text-white text-[9px] px-1.5 py-0.5 truncate pointer-events-none">
                            {new Date(item.timestamp).toLocaleDateString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </aside>

      </div>

      {/* 图片详情模态框 */}
      {previewImage && (
        <div className="fixed inset-0 bg-[#4A3B32]/70 backdrop-blur-sm z-50 flex items-center justify-center p-2 md:p-6" onClick={() => setPreviewImage(null)}>
          <div className="bg-[#FDFBF7] border-2 border-[#D9C5A0] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center p-3 md:p-4 border-b border-[#EADDCA]">
              <h3 className="text-sm md:text-base font-bold text-[#5C4A3D] flex items-center gap-2"><Clock className="w-4 h-4" /> {new Date(previewImage.timestamp).toLocaleString()}</h3>
              <div className="flex gap-2">
                <button onClick={() => handleDownloadImage(previewImage.image, 0)} className="p-2 bg-[#D35400] text-white rounded-lg hover:bg-[#BA4A00]" title="下载">
                  <Download className="w-4 h-4" />
                </button>
                <button onClick={async () => {
                  await dbDeleteImage(previewImage.id);
                  setSavedImages(prev => prev.filter(x => x.id !== previewImage.id));
                  setPreviewImage(null);
                }} className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600" title="删除">
                  <Trash2 className="w-4 h-4" />
                </button>
                <button onClick={() => setPreviewImage(null)} className="p-2 bg-[#F4EBD0] border border-[#C8B494] rounded-lg hover:bg-[#EADDCA] text-[#8B7355]">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-black/5 flex items-center justify-center p-2 min-h-0">
              <img src={previewImage.image} alt="preview" className="max-w-full max-h-[50vh] object-contain rounded" />
            </div>
            <div className="p-3 md:p-4 border-t border-[#EADDCA] space-y-2 text-xs max-h-[30vh] overflow-y-auto custom-scrollbar">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[#8B7355]">
                <div className="flex justify-between"><span className="font-bold">模型</span><span className="font-mono text-[#5C4A3D] truncate max-w-[120px]">{previewImage.model}</span></div>
                <div className="flex justify-between"><span className="font-bold">尺寸</span><span className="font-mono text-[#5C4A3D]">{previewImage.width}x{previewImage.height}</span></div>
                <div className="flex justify-between"><span className="font-bold">步数</span><span className="font-mono text-[#5C4A3D]">{previewImage.steps}</span></div>
                <div className="flex justify-between"><span className="font-bold">种子</span><span className="font-mono text-[#5C4A3D]">{previewImage.seed}</span></div>
              </div>
              <div>
                <span className="font-bold text-[#8B7355] block mb-0.5">正向咒语</span>
                <p className="text-[#5C4A3D] bg-[#F4EBD0]/50 p-2 rounded border border-[#EADDCA] break-words leading-relaxed">{previewImage.prompt}</p>
              </div>
              <div>
                <span className="font-bold text-[#C1827A] block mb-0.5">负面咒语</span>
                <p className="text-[#8A4A43] bg-[#F9F0ED]/50 p-2 rounded border border-[#E8C8C2] break-words leading-relaxed">{previewImage.negativePrompt}</p>
              </div>
              <button onClick={() => {
                handleApplyMetadata({
                  prompt: previewImage.prompt,
                  negativePrompt: previewImage.negativePrompt,
                  model: previewImage.model,
                  width: previewImage.width,
                  height: previewImage.height,
                  steps: previewImage.steps,
                  seed: previewImage.seed,
                });
                setPreviewImage(null);
              }} className="w-full py-2 rounded-lg font-bold text-xs bg-gradient-to-b from-[#E67E22] to-[#D35400] text-white border border-[#A04000] hover:from-[#D35400] hover:to-[#BA4A00] shadow transition-all flex items-center justify-center gap-2">
                <FileUp className="w-3.5 h-3.5" /> 使用这组参数
              </button>
            </div>
          </div>
        </div>
      )}

      {/* JSON 预览模态框 */}
      {showPreview && (
        <div className="fixed inset-0 bg-[#4A3B32]/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 md:p-6" onClick={() => setShowPreview(false)}>
          <div className="bg-[#FDFBF7] border-2 border-[#D9C5A0] rounded-2xl p-3 md:p-6 w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4 pb-3 border-b border-[#EADDCA]">
              <h3 className="text-xl font-bold text-[#5C4A3D] flex items-center gap-2"><Code className="w-5 h-5" /> NovelAI 请求体预览</h3>
              <div className="flex gap-2">
                <button onClick={handleCopyRequest} className="p-2 bg-[#F4EBD0] border border-[#C8B494] rounded-lg hover:bg-[#EADDCA] text-[#8B7355]" title="复制 JSON">
                  <Copy className="w-4 h-4" />
                </button>
                <button onClick={() => setShowPreview(false)} className="p-2 bg-[#F4EBD0] border border-[#C8B494] rounded-lg hover:bg-[#EADDCA] text-[#8B7355]">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto bg-[#E8DCC4]/40 border border-[#D9C5A0] rounded-lg p-4 text-xs text-[#4A3B32] font-mono custom-scrollbar leading-relaxed">
              {JSON.stringify(buildRequestBody(), null, 2)}
            </pre>
          </div>
        </div>
      )}
      
      {/* 元数据导入模态框 */}
      {showImportModal && (
        <div className="fixed inset-0 bg-[#4A3B32]/70 backdrop-blur-sm z-50 flex items-center justify-center p-2 md:p-6" onClick={() => { setShowImportModal(false); setImportedMeta(null); }}>
          <div className="bg-[#FDFBF7] border-2 border-[#D9C5A0] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center p-3 md:p-4 border-b border-[#EADDCA]">
              <h3 className="text-sm md:text-base font-bold text-[#5C4A3D] flex items-center gap-2"><FileUp className="w-4 h-4 text-[#D35400]" /> 导入图片元数据</h3>
              <button onClick={() => { setShowImportModal(false); setImportedMeta(null); }} className="p-2 bg-[#F4EBD0] border border-[#C8B494] rounded-lg hover:bg-[#EADDCA] text-[#8B7355]">
                <X className="w-4 h-4" />
              </button>
            </div>

            {importedMeta ? (
              <>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-3 md:p-5 space-y-4">
                  {importThumbnail && (
                    <div className="flex justify-center">
                      <img src={importThumbnail} alt="preview" className="max-h-40 rounded-lg border-2 border-[#D9C5A0] shadow" />
                    </div>
                  )}
                  <div className="space-y-3">
                    {importedMeta.prompt && (
                      <div>
                        <label className="text-xs font-bold text-[#8B7355] block mb-1">正向提示词 (Prompt)</label>
                        <div className="text-xs text-[#5C4A3D] bg-[#F4EBD0]/50 p-3 rounded-lg border border-[#EADDCA] break-words leading-relaxed max-h-32 overflow-y-auto custom-scrollbar">{importedMeta.prompt}</div>
                      </div>
                    )}
                    {importedMeta.negativePrompt && (
                      <div>
                        <label className="text-xs font-bold text-[#C1827A] block mb-1">负面提示词 (Negative)</label>
                        <div className="text-xs text-[#8A4A43] bg-[#F9F0ED]/50 p-3 rounded-lg border border-[#E8C8C2] break-words leading-relaxed max-h-24 overflow-y-auto custom-scrollbar">{importedMeta.negativePrompt}</div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {importedMeta.model && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">模型</span>
                          <span className="text-xs font-mono text-[#5C4A3D] truncate block">{importedMeta.model}</span>
                        </div>
                      )}
                      {importedMeta.width && importedMeta.height && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">尺寸</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.width} x {importedMeta.height}</span>
                        </div>
                      )}
                      {importedMeta.steps && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">步数</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.steps}</span>
                        </div>
                      )}
                      {importedMeta.scale && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">CFG Scale</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.scale}</span>
                        </div>
                      )}
                      {importedMeta.sampler && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">采样器</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.sampler}</span>
                        </div>
                      )}
                      {importedMeta.seed !== undefined && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">种子</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.seed}</span>
                        </div>
                      )}
                      {importedMeta.noiseSchedule && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">噪声调度</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.noiseSchedule}</span>
                        </div>
                      )}
                      {importedMeta.sm !== undefined && (
                        <div className="bg-[#F4EBD0]/50 p-2 rounded-lg border border-[#EADDCA]">
                          <span className="text-[10px] font-bold text-[#A68A61] block">SMEA</span>
                          <span className="text-xs font-mono text-[#5C4A3D]">{importedMeta.sm ? 'ON' : 'OFF'}{importedMeta.smDyn ? ' +Dyn' : ''}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-3 p-3 md:p-4 border-t border-[#EADDCA]">
                  <button onClick={() => { setShowImportModal(false); setImportedMeta(null); }}
                    className="flex-1 py-2.5 rounded-xl font-bold text-sm bg-[#F4EBD0] text-[#8B7355] border border-[#C8B494] hover:bg-[#EADDCA] transition-colors">
                    取消
                  </button>
                  <button onClick={() => handleApplyMetadata(importedMeta)}
                    className="flex-1 py-2.5 rounded-xl font-bold text-sm bg-gradient-to-b from-[#E67E22] to-[#D35400] text-white border border-[#A04000] hover:from-[#D35400] hover:to-[#BA4A00] shadow-lg transition-all">
                    应用到当前设置
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-10 gap-4">
                {importThumbnail && (
                  <img src={importThumbnail} alt="preview" className="max-h-32 rounded-lg border-2 border-[#D9C5A0] shadow opacity-60" />
                )}
                <div className="w-16 h-16 bg-[#EADDCA] rounded-full flex items-center justify-center">
                  <X className="w-8 h-8 text-[#C8B494]" />
                </div>
                <h3 className="text-[#5C4A3D] font-bold text-lg text-center">未找到元数据</h3>
                <div className="text-[#8B7355] text-xs text-center leading-relaxed max-w-sm space-y-2">
                  <p>该图片中没有嵌入 AI 生成参数。可能的原因：</p>
                  <ul className="text-left space-y-1 bg-[#F4EBD0]/50 p-3 rounded-lg border border-[#EADDCA]">
                    <li>- 通过中转服务器生成的图片（元数据被剥离）</li>
                    <li>- 图片经过截图/重新保存/压缩处理</li>
                    <li>- 图片非 AI 生成或格式不支持</li>
                  </ul>
                  <p className="text-[10px] text-[#A68A61] mt-2">支持: NovelAI 官方 PNG / SD WebUI (A1111) / ComfyUI</p>
                  <p className="text-[10px] text-[#A68A61]">本应用生成的图片参数保存在「历史画廊」中，点击图片详情可查看</p>
                </div>
                <button onClick={() => { setShowImportModal(false); setImportedMeta(null); }}
                  className="mt-2 py-2 px-6 rounded-xl font-bold text-sm bg-[#E8DCC4] text-[#8B7355] border border-[#C8B494] hover:bg-[#D9C5A0] transition-colors">
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 移动端底部导航栏 */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-[#F4EBD0]/95 backdrop-blur-sm border-t-2 border-[#C8B494] z-40 flex">
        {[
          { id: 'settings' as const, icon: Settings2, label: '参数' },
          { id: 'prompts' as const, icon: PenTool, label: '咒语' },
          { id: 'results' as const, icon: Sparkles, label: '结果' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setMobilePanel(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors ${
              mobilePanel === tab.id 
                ? 'text-[#D35400] bg-[#E8DCC4]/50' 
                : 'text-[#8B7355]'
            }`}>
            <tab.icon className="w-5 h-5" />
            <span className="text-[10px] font-bold">{tab.label}</span>
            {tab.id === 'results' && resultImages.length > 0 && (
              <span className="absolute top-1 right-[calc(50%-12px)] translate-x-[14px] bg-[#D35400] text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {resultImages.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #D9C5A0; border-radius: 20px; border: 2px solid #FDFBF7; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #C8B494; }
      `}} />
    </div>
  );
}
