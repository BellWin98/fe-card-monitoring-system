import React, { useEffect, useRef, useState } from 'react';
import axios, { AxiosError } from 'axios';
import './App.css';

type ProgressPhase = 'idle' | 'uploading' | 'queued' | 'processing' | 'downloading' | 'complete';

type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  processed: number;
  total: number;
  message: string | null;
}

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

// 새로고침 후에도 진행 중인 작업을 이어서 추적하기 위한 저장 키
const JOB_STORAGE_KEY = 'card-monitoring:jobId';
const POLL_INTERVAL_MS = 2000;
// 일시적인 네트워크 오류는 이 횟수(약 2분)까지 재시도한다.
const MAX_CONSECUTIVE_POLL_FAILURES = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadSavedJobId = (): string | null => {
  try {
    return localStorage.getItem(JOB_STORAGE_KEY);
  } catch {
    return null;
  }
};

const saveJobId = (jobId: string | null) => {
  try {
    if (jobId) localStorage.setItem(JOB_STORAGE_KEY, jobId);
    else localStorage.removeItem(JOB_STORAGE_KEY);
  } catch {
    // 저장소를 사용할 수 없는 환경에서는 새로고침 시 이어받기만 동작하지 않는다.
  }
};

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
  queued: '분석 대기 중',
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

  // 언마운트 이후 폴링 루프를 중단하기 위한 플래그
  const unmountedRef = useRef(false);
  // StrictMode에서 이어받기가 두 번 실행되지 않도록 막는다.
  const resumedRef = useRef(false);

  const handleError = async (error: unknown) => {
    console.error('분석 중 오류 발생:', error);

    let message = '분석 중 오류가 발생했습니다.';
    if (error instanceof AxiosError && error.response?.data instanceof Blob) {
      message = await parseBlobError(error.response.data);
    } else if (error instanceof AxiosError && error.response?.data?.message) {
      message = error.response.data.message;
    } else if (error instanceof Error) {
      message = error.message;
    }

    setProgress(INITIAL_PROGRESS);
    setStatusMessage({ type: 'error', text: message });
  };

  /** 작업이 끝날 때까지 상태를 주기적으로 조회한다. 일시적인 네트워크 오류는 재시도한다. */
  const waitForCompletion = async (jobId: string): Promise<void> => {
    let consecutiveFailures = 0;

    while (!unmountedRef.current) {
      try {
        const { data } = await axios.get<JobStatusResponse>(`/api/monitor/jobs/${jobId}`);
        consecutiveFailures = 0;

        if (data.status === 'COMPLETED') return;
        if (data.status === 'FAILED') {
          saveJobId(null);
          throw new Error(data.message ?? '분석 중 오류가 발생했습니다.');
        }
        setProgress(
          data.status === 'PENDING'
            ? { phase: 'queued', loaded: 0, total: 0 }
            : { phase: 'processing', loaded: data.processed, total: data.total },
        );
      } catch (error) {
        if (!(error instanceof AxiosError)) throw error;
        // 작업이 없으면(만료/서버 재시작) 재시도해도 의미가 없다.
        if (error.response?.status === 404) {
          saveJobId(null);
          throw error;
        }

        consecutiveFailures += 1;
        console.warn(`상태 조회 실패 (${consecutiveFailures}회), 재시도합니다.`, error);
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new Error('서버와 연결할 수 없습니다. 분석은 서버에서 계속 진행 중이니 잠시 후 페이지를 새로고침해 주세요.');
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }
  };

  const downloadResult = async (jobId: string) => {
    setProgress({ phase: 'downloading', loaded: 0, total: 0 });

    const response = await axios.get(`/api/monitor/jobs/${jobId}/result`, {
      responseType: 'blob',
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

    saveJobId(null);
    setProgress({ phase: 'complete', loaded: blob.size, total: blob.size });
    setStatusMessage({ type: 'success', text: '분석이 완료되었습니다. 파일이 다운로드됩니다.' });
  };

  const trackJob = async (jobId: string) => {
    await waitForCompletion(jobId);
    if (unmountedRef.current) return;
    await downloadResult(jobId);
  };

  // 새로고침 등으로 페이지가 다시 열려도 진행 중이던 작업을 이어서 추적한다.
  useEffect(() => {
    unmountedRef.current = false;
    const savedJobId = loadSavedJobId();
    if (savedJobId && !resumedRef.current) {
      resumedRef.current = true;
      setProgress({ phase: 'processing', loaded: 0, total: 0 });
      trackJob(savedJobId).catch(handleError);
    }
    return () => {
      unmountedRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // 업로드 요청은 작업 등록만 하고 즉시 jobId를 받는다. (분석은 서버 백그라운드에서 진행)
      const { data } = await axios.post<JobStatusResponse>('/api/monitor/analyze', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          const total = e.total ?? file.size;
          setProgress({ phase: 'uploading', loaded: Math.min(e.loaded, total), total });
        },
      });

      saveJobId(data.jobId);
      setProgress({ phase: 'queued', loaded: 0, total: 0 });
      await trackJob(data.jobId);
    } catch (error) {
      await handleError(error);
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

    if (phase === 'queued') {
      return '앞선 분석 작업이 끝나면 시작됩니다.';
    }

    if (phase === 'processing') {
      if (total > 0) {
        const percent = getProgressPercent();
        return `${percent}% (${loaded.toLocaleString()} / ${total.toLocaleString()}건) · 완료되면 결과 파일이 자동으로 다운로드됩니다.`;
      }
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
      <p>엑셀 파일을 업로드하여 자택-가맹점 간 거리를 분석하세요.</p>

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
            {percent === null ? (
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
