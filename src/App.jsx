import React, { useState, useRef, useMemo } from 'react';
import { Upload, FileText, Download, Loader2, RefreshCw, Settings, X, Key, AlertCircle } from 'lucide-react';

/** ====================== SRT Utility ====================== */
const parseSRT = (data) => {
  const normalized = data.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.trim().split(/\n\s*\n+/);

  return blocks
    .map((block) => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) return null;

      let id, timecode, text;
      if (lines[0].includes('-->')) {
        id = Math.random().toString(36).substr(2, 9);
        timecode = lines[0];
        text = lines.slice(1).join('\n');
      } else {
        id = lines[0];
        timecode = lines[1];
        text = lines.slice(2).join('\n');
      }

      return timecode?.includes('-->')
        ? { id, timecode, originalText: text || "", translatedText: '' }
        : null;
    })
    .filter(Boolean);
};

const generateSRT = (subtitles) => {
  return subtitles
    .map(sub => `${sub.id}\n${sub.timecode}\n${sub.translatedText || sub.originalText}`)
    .join('\n\n');
};

const safeParseJSON = (text) => {
  let clean = text.trim()
    .replace(/```json/g, '').replace(/```/g, '')
    .trim();

  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start !== -1 && end !== -1) {
    clean = clean.substring(start, end + 1);
  }

  return JSON.parse(clean);
};

/** ====================== System Prompt ====================== */
const SYSTEM_PROMPT = `
あなたは世界最高峰の映像翻訳家で、特に洋画・海外ドラマの字幕翻訳に長けた男性翻訳者だ。

英語の字幕を**自然で男らしい日本語の口語体**に翻訳せよ。
- 丁寧語（です・ます）は一切使わない
- 男らしい口語（だ、よ、ぜ、な、だろう、じゃねえか、など）を自然に使う
- 若者寄りのカジュアルで力強い口調を基本とする
- 状況に応じて荒っぽくも、クールにも調整する
- 文脈をしっかり考慮して自然な流れにする

【出力形式】
必ず以下の純粋なJSON配列のみを出力。説明文・Markdownは一切禁止。
[
  {"id": "識別子", "text": "翻訳文"},
  ...
]
`;

/** ====================== Main Component ====================== */
export default function App() {
  // 追加: APIキー管理をローカル状態のみに変更（Firebase削除に伴い）
  const [apiKey, setApiKey] = useState('');
  const [file, setFile] = useState(null);
  const [subtitles, setSubtitles] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const fileInputRef = useRef(null);

  // 更新: Firebase関連のuseEffectを削除（Firebase削除に伴い）

  const fetchWithRetry = async (fetchFn, retries = 5, delay = 1000) => {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await fetchFn();
        if (response.ok) return response;

        if ((response.status === 429 || response.status >= 500) && i < retries) {
          let nextDelay = delay;
          if (response.status === 429) {
            try {
              const errorData = await response.clone().json();
              const match = errorData?.error?.message?.match(/retry in ([\d.]+)s/);
              if (match) nextDelay = (parseFloat(match[1]) + 0.5) * 1000;
            } catch {}
          }
          await new Promise(r => setTimeout(r, nextDelay));
          delay *= 2;
          continue;
        }
        return response;
      } catch (err) {
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }
  };

  const handleFileUpload = (event) => {
    const uploadedFile = event.target.files[0];
    if (!uploadedFile) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseSRT(e.target.result);
        if (parsed.length === 0) throw new Error('SRT形式として認識できません。');
        setSubtitles(parsed);
        setFile(uploadedFile);
        setError('');
      } catch (err) {
        setError(err.message);
      }
    };
    reader.readAsText(uploadedFile);
  };

  const handleReset = () => {
    setFile(null);
    setSubtitles([]);
    setProgress(0);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleTranslate = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setError("APIキーが設定されていません。");
      setShowSettings(true);
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setError('');

    let currentSubtitles = [...subtitles];
    const BATCH_SIZE = 50; // 定数を関数内に移動
    const totalBatches = Math.ceil(subtitles.length / BATCH_SIZE);

    for (let i = 0; i < totalBatches; i++) {
      const start = i * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, subtitles.length);
      const batch = currentSubtitles.slice(start, end);

      if (batch.every(s => s.translatedText)) {
        setProgress(((i + 1) / totalBatches) * 100);
        continue;
      }

      try {
        const payload = batch.map(s => ({ id: s.id, text: s.originalText }));

        const response = await fetchWithRetry(() =>
          fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${trimmedKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Translate this JSON to Japanese:\n${JSON.stringify(payload)}` }] }],
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              generationConfig: { responseMimeType: "application/json", temperature: 0.15 }
            })
          })
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData?.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        const translatedBatch = safeParseJSON(resultText);

        translatedBatch.forEach(t => {
          const index = currentSubtitles.findIndex(s => String(s.id) === String(t.id));
          if (index !== -1) {
            currentSubtitles[index] = { ...currentSubtitles[index], translatedText: t.text };
          }
        });

        setSubtitles([...currentSubtitles]);
        setProgress(((i + 1) / totalBatches) * 100);
      } catch (err) {
        setError(`バッチ ${i + 1} でエラーが発生: ${err.message}`);
        setIsProcessing(false);
        return;
      }
    }
    setIsProcessing(false);
  };

  const handleTextChange = (id, newText) => {
    setSubtitles(prev => prev.map(sub => sub.id === id ? { ...sub, translatedText: newText } : sub));
  };

  const handleDownload = () => {
    const content = generateSRT(subtitles);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file ? `${file.name.replace(/\.[^/.]+$/, "")}_jpn.srt` : 'translated.srt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const visibleSubtitles = useMemo(() => subtitles.slice(0, 100), [subtitles]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 p-2 rounded-lg text-white">
              <FileText size={20} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">SRT Translator (男性口語体)</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-3 rounded-full transition-all ${showSettings ? 'bg-blue-100 text-blue-600' : 'text-gray-600 hover:bg-gray-100'}`}
              aria-label="設定を開く"
            >
              <Settings size={24} />
            </button>

            {subtitles.length > 0 && (
              <button
                onClick={handleDownload}
                disabled={isProcessing || subtitles.every(s => !s.translatedText)}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-6 py-2.5 rounded-lg font-medium disabled:opacity-50 transition-all shadow-sm"
              >
                <Download size={18} /> SRT保存
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-start gap-3">
            <AlertCircle className="mt-0.5 shrink-0" size={18} />
            <p>{error}</p>
          </div>
        )}

        {showSettings && (
          <div className="mb-8 bg-white p-6 rounded-xl shadow-sm border relative z-40">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Key size={20} /> APIキー設定
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-red-500 p-1">
                <X size={22} />
              </button>
            </div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <p className="mt-2 text-xs text-gray-500">Google AI Studioで取得したGemini APIキーを入力してください。</p>
          </div>
        )}

        {subtitles.length === 0 ? (
          <div className="max-w-2xl mx-auto mt-12 text-center">
            <label htmlFor="srt-upload" className="block border-2 border-dashed border-gray-300 rounded-2xl p-12 hover:border-blue-500 hover:bg-blue-50 cursor-pointer transition-all">
              <input id="srt-upload" ref={fileInputRef} type="file" accept=".srt" onChange={handleFileUpload} className="hidden" />
              <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <Upload size={32} />
              </div>
              <h3 className="text-xl font-semibold">SRTファイルをアップロード</h3>
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
            <div className="lg:col-span-1">
              <div className="bg-white p-6 rounded-xl shadow-sm border sticky top-24 z-30">
                <h3 className="text-xs font-bold text-gray-400 uppercase mb-3">ステータス</h3>
                <p className="font-bold truncate mb-1">{file?.name}</p>
                <p className="text-sm text-gray-500 mb-6">{subtitles.length.toLocaleString()} 字幕</p>

                <div className="space-y-4">
                  {isProcessing ? (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="flex items-center gap-2 text-blue-600">
                          <Loader2 className="animate-spin" size={16} />翻訳中
                        </span>
                        <span>{Math.round(progress)}%</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={handleTranslate}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold shadow-lg transition-all"
                    >
                      翻訳を開始（男性口語体）
                    </button>
                  )}
                  <button
                    onClick={handleReset}
                    className="w-full border border-gray-300 text-gray-700 py-3 rounded-xl font-semibold hover:bg-gray-50 flex items-center justify-center gap-2"
                  >
                    <RefreshCw size={18} />リセット
                  </button>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3">
              <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                {visibleSubtitles.map((sub) => (
                  <div key={sub.id} className="p-4 border-b last:border-b-0 hover:bg-gray-50 transition-colors">
                    <div className="flex items-start gap-4">
                      <div className="w-8 text-[10px] font-mono text-gray-400 mt-1">{sub.id}</div>
                      <div className="flex-1 grid grid-cols-2 gap-4">
                        <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{sub.originalText}</div>
                        <textarea
                          value={sub.translatedText}
                          onChange={(e) => handleTextChange(sub.id, e.target.value)}
                          placeholder="翻訳結果..."
                          className="w-full p-3 text-sm border rounded-lg bg-gray-50 focus:bg-white focus:ring-1 focus:ring-blue-400 outline-none resize-y min-h-[60px]"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
