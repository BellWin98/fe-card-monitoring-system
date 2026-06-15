import React, { useState } from 'react';
import axios, { AxiosError } from 'axios';
import './App.css';

type ProgressPhase = 'idle' | 'uploading' | 'processing' | 'downloading' | 'complete';

interface ProgressState {
  phase: ProgressPhase;
  loaded: number;
  total: number;
}

interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

const INITIAL_PROGRESS: ProgressState = { phase: 'idle', loaded: 0, total: 0 };

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const extractFilename = (contentDisposition: string | undefined): string | null => {
  if (!contentDisposition) return null;
  const match = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1].replace(/['"]/g, ''));
  } catch {
    return match[1].replace(/['"]/g, '');
  }
};

const parseBlobError = async (blob: Blob): Promise<string> => {
  try {
    const text = await blob.text();
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? '분석 중 오류가 발생했습니다.';
  } catch {
    return '분석 중 오류가 발생했습니다.';
  }
};

const PHASE_LABELS: Record<Exclude<ProgressPhase, 'idle' | 'complete'>, string> = {
  uploading: '파일 업로드 중',
  processing: '서버에서 분석 중',
  downloading: '결과 다운로드 중',
};

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);

  const isBusy = progress.phase !== 'idle' && progress.phase !== 'complete';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0]);
      setStatusMessage(null);
      setProgress(INITIAL_PROGRESS);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      alert('엑셀 파일을 먼저 업로드해 주세요!');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setStatusMessage(null);
    setProgress({ phase: 'uploading', loaded: 0, total: file.size });

    try {
      const response = await axios.post('/api/monitor/analyze', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        responseType: 'blob',
        onUploadProgress: (e) => {
          const total = e.total ?? file.size;
          if (e.loaded >= total) {
            setProgress({ phase: 'processing', loaded: 0, total: 0 });
          } else {
            setProgress({ phase: 'uploading', loaded: e.loaded, total });
          }
        },
        onDownloadProgress: (e) => {
          setProgress({
            phase: 'downloading',
            loaded: e.loaded,
            total: e.total ?? 0,
          });
        },
      });

      const blob = response.data as Blob;

      if (blob.type.includes('json')) {
        const message = await parseBlobError(blob);
        throw new Error(message);
      }

      const filename =
        extractFilename(response.headers['content-disposition']) ??
        `analysis_result_${Date.now()}.xlsx`;

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      setProgress({ phase: 'complete', loaded: blob.size, total: blob.size });
      setStatusMessage({ type: 'success', text: '분석이 완료되었습니다. 파일이 다운로드됩니다.' });
    } catch (error) {
      console.error('분석 중 오류 발생:', error);

      let message = '분석 중 오류가 발생했습니다.';
      if (error instanceof AxiosError && error.response?.data instanceof Blob) {
        message = await parseBlobError(error.response.data);
      } else if (error instanceof Error) {
        message = error.message;
      }

      setProgress(INITIAL_PROGRESS);
      setStatusMessage({ type: 'error', text: message });
    }
  };

  const getProgressPercent = (): number | null => {
    if (progress.total > 0) {
      return Math.min(100, Math.round((progress.loaded / progress.total) * 100));
    }
    return null;
  };

  const getProgressDetail = (): string => {
    const { phase, loaded, total } = progress;

    if (phase === 'processing') {
      return '분석이 완료되면 결과 파일 다운로드가 시작됩니다.';
    }

    if (total > 0) {
      const percent = getProgressPercent();
      return `${percent}% (${formatBytes(loaded)} / ${formatBytes(total)})`;
    }

    if (loaded > 0) {
      return `${formatBytes(loaded)} 수신 중...`;
    }

    return '';
  };

  const percent = getProgressPercent();
  const showProgress = isBusy;

  return (
    <div className="app-container">
      <h1>💳 법인카드 부정사용 모니터링</h1>
      <p>엑셀 파일을 업로드하여 자택-가맹점 간 거리를 분석하세요. (기준: 2km)</p>

      <div className="file-upload-area">
        <input type="file" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isBusy} />
      </div>

      <button onClick={handleUpload} disabled={isBusy} className="analyze-button">
        {isBusy ? '처리 중...' : '분석 시작 및 결과 다운로드'}
      </button>

      {showProgress && (
        <div className="progress-panel">
          <p className="progress-label">
            {PHASE_LABELS[progress.phase as keyof typeof PHASE_LABELS]}
          </p>
          <div className="progress-bar-track">
            {progress.phase === 'processing' || percent === null ? (
              <div className="progress-bar-indeterminate" />
            ) : (
              <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
            )}
          </div>
          <p className="progress-detail">{getProgressDetail()}</p>
        </div>
      )}

      {statusMessage && (
        <p className={`status-message status-message--${statusMessage.type}`}>
          {statusMessage.text}
        </p>
      )}
    </div>
  );
};

export default App;
