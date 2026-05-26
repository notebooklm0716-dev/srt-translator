import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Upload,
  FileText,
  Download,
  Loader2,
  RefreshCw,
  Settings,
  X,
  Key,
  AlertCircle
} from 'lucide-react';

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCustomToken
} from 'firebase/auth';

import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot
} from 'firebase/firestore';

const firebaseConfig = JSON.parse(__firebase_config);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const appId =
  typeof __app_id !== 'undefined'
    ? __app_id
    : 'srt-translator-app';

const VIEW_LIMIT = 100;
const BATCH_SIZE = 50;

/* ====================== SRT Utility ====================== */

const parseSRT = (data) => {
  const normalized = data
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const blocks = normalized.trim().split(/\n\s*\n+/);

  return blocks
    .map((block) => {
      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length < 2) return null;

      let id;
      let timecode;
      let text;

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
        ? {
            id,
            timecode,
            originalText: text || '',
            translatedText: ''
          }
        : null;
    })
    .filter(Boolean);
};

const generateSRT = (subtitles) => {
  return subtitles
    .map(
      (sub) =>
        `${sub.id}\n${sub.timecode}\n${
          sub.translatedText || sub.originalText
        }`
    )
    .join('\n\n');
};

const safeParseJSON = (text) => {
  let clean = text
    .trim()
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');

  if (start !== -1 && end !== -1) {
    clean = clean.substring(start, end + 1);
  }

  return JSON.parse(clean);
};

/* ====================== Prompt ====================== */

const SYSTEM_PROMPT = `
あなたは世界最高峰の映像翻訳家で、特に洋画・海外ドラマの字幕翻訳に長けた男性翻訳者だ。

英語の字幕を自然で男らしい日本語の口語体に翻訳せよ。

- 丁寧語は禁止
- 男らしい口語
- カジュアル
- 文脈重視

必ずJSON配列のみ返すこと。
`;

/* ====================== Main ====================== */

export default function App() {
  const [apiKey, setApiKey] = useState('');
  const [user, setUser] = useState(null);

  const [file, setFile] = useState(null);

  const [subtitles, setSubtitles] = useState([]);

  const [isProcessing, setIsProcessing] =
    useState(false);

  const [progress, setProgress] = useState(0);

  const [error, setError] = useState('');

  const [showSettings, setShowSettings] =
    useState(false);

  const fileInputRef = useRef(null);

  /* ====================== Auth ====================== */

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (
          typeof __initial_auth_token !== 'undefined' &&
          __initial_auth_token
        ) {
          await signInWithCustomToken(
            auth,
            __initial_auth_token
          );
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        setError(
          '認証に失敗しました。ページを再読み込みしてください。'
        );
      }
    };

    initAuth();

    const unsubscribe = onAuthStateChanged(
      auth,
      setUser
    );

    return () => unsubscribe();
  }, []);

  /* ====================== Firestore ====================== */

  useEffect(() => {
    if (!user) return;

    const configDoc = doc(
      db,
      'artifacts',
      appId,
      'users',
      user.uid,
      'settings',
      'config'
    );

    const unsubscribe = onSnapshot(configDoc, (snap) => {
      if (snap.exists()) {
        const data = snap.data();

        if (data.apiKey) {
          setApiKey(data.apiKey);
        }
      }
    });

    return () => unsubscribe();
  }, [user]);

  const handleApiKeyChange = async (value) => {
    setApiKey(value);

    if (!user) return;

    try {
      const configDoc = doc(
        db,
        'artifacts',
        appId,
        'users',
        user.uid,
        'settings',
        'config'
      );

      await setDoc(
        configDoc,
        { apiKey: value },
        { merge: true }
      );
    } catch (err) {
      console.error(err);
    }
  };

  /* ====================== Retry ====================== */

  const fetchWithRetry = async (
    fetchFn,
    retries = 5,
    delay = 1000
  ) => {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await fetchFn();

        if (response.ok) {
          return response;
        }

        if (
          (response.status === 429 ||
            response.status >= 500) &&
          i < retries
        ) {
          await new Promise((r) =>
            setTimeout(r, delay)
          );

          delay *= 2;

          continue;
        }

        return response;
      } catch (err) {
        if (i === retries) {
          throw err;
        }

        await new Promise((r) =>
          setTimeout(r, delay)
        );

        delay *= 2;
      }
    }
  };

  /* ====================== Upload ====================== */

  const handleFileUpload = (event) => {
    const uploadedFile = event.target.files[0];

    if (!uploadedFile) return;

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const parsed = parseSRT(e.target.result);

        if (parsed.length === 0) {
          throw new Error(
            'SRT形式として認識できません。'
          );
        }

        setSubtitles(parsed);
        setFile(uploadedFile);
        setError('');
      } catch (err) {
        setError(err.message);
      }
    };

    reader.readAsText(uploadedFile);
  };

  /* ====================== Reset ====================== */

  const handleReset = () => {
    setFile(null);
    setSubtitles([]);
    setProgress(0);
    setError('');

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  /* ====================== Translate ====================== */

  const handleTranslate = async () => {
    const trimmedKey = apiKey.trim();

    if (!trimmedKey) {
      setError('APIキーが設定されていません。');
      setShowSettings(true);
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setError('');

    let currentSubtitles = [...subtitles];

    const totalBatches = Math.ceil(
      subtitles.length / BATCH_SIZE
    );

    for (let i = 0; i < totalBatches; i++) {
      const start = i * BATCH_SIZE;
      const end = Math.min(
        start + BATCH_SIZE,
        subtitles.length
      );

      const batch = currentSubtitles.slice(
        start,
        end
      );

      try {
        const payload = batch.map((s) => ({
          id: s.id,
          text: s.originalText
        }));

        const response = await fetchWithRetry(() =>
          fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${trimmedKey}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        text: `Translate this JSON:\n${JSON.stringify(
                          payload
                        )}`
                      }
                    ]
                  }
                ],
                systemInstruction: {
                  parts: [
                    {
                      text: SYSTEM_PROMPT
                    }
                  ]
                },
                generationConfig: {
                  responseMimeType:
                    'application/json',
                  temperature: 0.15
                }
              })
            }
          )
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        const resultText =
          data.candidates?.[0]?.content?.parts?.[0]
            ?.text;

        const translatedBatch =
          safeParseJSON(resultText);

        translatedBatch.forEach((t) => {
          const index =
            currentSubtitles.findIndex(
              (s) =>
                String(s.id) === String(t.id)
            );

          if (index !== -1) {
            currentSubtitles[index] = {
              ...currentSubtitles[index],
              translatedText: t.text
            };
          }
        });

        setSubtitles([...currentSubtitles]);

        setProgress(
          ((i + 1) / totalBatches) * 100
        );
      } catch (err) {
        setError(
          `バッチ ${i + 1} エラー: ${err.message}`
        );

        setIsProcessing(false);

        return;
      }
    }

    setIsProcessing(false);
  };

  /* ====================== Edit ====================== */

  const handleTextChange = (id, newText) => {
    setSubtitles((prev) =>
      prev.map((sub) =>
        sub.id === id
          ? {
              ...sub,
              translatedText: newText
            }
          : sub
      )
    );
  };

  /* ====================== Download ====================== */

  const handleDownload = () => {
    const content = generateSRT(subtitles);

    const blob = new Blob([content], {
      type: 'text/plain;charset=utf-8'
    });

    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');

    link.href = url;

    link.download = file
      ? `${file.name.replace(
          /\.[^/.]+$/,
          ''
        )}_jpn.srt`
      : 'translated.srt';

    document.body.appendChild(link);

    link.click();

    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  };

  const visibleSubtitles = useMemo(
    () => subtitles.slice(0, VIEW_LIMIT),
    [subtitles]
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* HEADER */}
      <header className="sticky top-0 bg-white border-b shadow-sm z-20">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white p-2 rounded-lg">
              <FileText size={20} />
            </div>

            <h1 className="font-bold text-xl">
              SRT Translator
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* 追加理由: Chromeブラウザ環境や特定のサンドボックスiframe内で、ボタンへのマウスクリックやタップが背後レイヤーに阻害されるのを防ぐため、明示的に relative z-30 pointer-events-auto クラスを追加し、確実にインタラクションを受け取れるよう更新 */}
            <button
              type="button"
              onClick={() =>
                setShowSettings(true)
              }
              className="relative z-30 pointer-events-auto w-11 h-11 rounded-full flex items-center justify-center bg-gray-100 hover:bg-gray-200 active:scale-95 transition"
            >
              <Settings size={22} />
            </button>

            {subtitles.length > 0 && (
              /* 追加理由: Chromeブラウザ環境や特定のサンドボックスiframe内で、ボタンへのマウスクリックやタップが背後レイヤーに阻害されるのを防ぐため、明示的に relative z-30 pointer-events-auto クラスを追加し、確実にインタラクションを受け取れるよう更新 */
              <button
                type="button"
                onClick={handleDownload}
                disabled={
                  isProcessing ||
                  subtitles.every(
                    (s) => !s.translatedText
                  )
                }
                className="relative z-30 pointer-events-auto bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-lg flex items-center gap-2 font-semibold transition"
              >
                <Download size={18} />
                SRT保存
              </button>
            )}
          </div>
        </div>
      </header>

      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Key size={20} />
                APIキー設定
              </h2>

              <button
                onClick={() =>
                  setShowSettings(false)
                }
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X size={20} />
              </button>
            </div>

            <input
              type="password"
              value={apiKey}
              onChange={(e) =>
                handleApiKeyChange(
                  e.target.value
                )
              }
              placeholder="AIzaSy..."
              className="w-full border rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500"
            />

            <p className="mt-3 text-sm text-gray-500">
              Google AI Studio の Gemini APIキー
            </p>
          </div>
        </div>
      )}

      {/* MAIN */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 flex gap-3">
            <AlertCircle size={18} />
            <p>{error}</p>
          </div>
        )}

        {subtitles.length === 0 ? (
          <div className="max-w-2xl mx-auto mt-20">
            <label
              htmlFor="srt-upload"
              className="block border-2 border-dashed border-gray-300 rounded-3xl p-14 bg-white hover:border-blue-500 hover:bg-blue-50 cursor-pointer transition text-center"
            >
              <input
                id="srt-upload"
                type="file"
                accept=".srt"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />

              <div className="w-20 h-20 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mx-auto mb-5">
                <Upload size={36} />
              </div>

              <h3 className="text-2xl font-bold mb-2">
                SRTファイルをアップロード
              </h3>

              <p className="text-gray-500">
                クリックして選択
              </p>
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
            {/* LEFT */}
            <div>
              <div className="sticky top-24 bg-white border rounded-2xl p-6 shadow-sm">
                <p className="text-xs font-bold text-gray-400 mb-2">
                  STATUS
                </p>

                <p className="font-bold truncate">
                  {file?.name}
                </p>

                <p className="text-sm text-gray-500 mb-6">
                  {subtitles.length.toLocaleString()}
                  字幕
                </p>

                {isProcessing ? (
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="flex items-center gap-2 text-blue-600">
                        <Loader2
                          className="animate-spin"
                          size={16}
                        />
                        翻訳中
                      </span>

                      <span>
                        {Math.round(progress)}%
                      </span>
                    </div>

                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-600 transition-all"
                        style={{
                          width: `${progress}%`
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={handleTranslate}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold transition"
                  >
                    翻訳開始
                  </button>
                )}

                <button
                  onClick={handleReset}
                  className="w-full mt-4 border rounded-xl py-3 flex items-center justify-center gap-2 hover:bg-gray-50"
                >
                  <RefreshCw size={18} />
                  リセット
                </button>
              </div>
            </div>

            {/* RIGHT */}
            <div className="lg:col-span-3">
              <div className="bg-white border rounded-2xl overflow-hidden shadow-sm">
                {visibleSubtitles.map((sub) => (
                  <div
                    key={sub.id}
                    className="border-b p-4 hover:bg-gray-50"
                  >
                    <div className="flex gap-4">
                      <div className="w-10 text-xs text-gray-400 font-mono">
                        {sub.id}
                      </div>

                      <div className="flex-1 grid grid-cols-2 gap-4">
                        <div className="text-sm whitespace-pre-wrap">
                          {sub.originalText}
                        </div>

                        <textarea
                          value={sub.translatedText}
                          onChange={(e) =>
                            handleTextChange(
                              sub.id,
                              e.target.value
                            )
                          }
                          placeholder="翻訳結果..."
                          className="w-full min-h-[70px] border rounded-lg p-3 bg-gray-50 focus:bg-white outline-none focus:ring-2 focus:ring-blue-400 resize-y"
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
