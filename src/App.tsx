import React, { useState } from 'react';
import axios from 'axios';

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // 파일 선택 핸들러
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0]);
    }
  };

  // 분석 및 다운로드 요청
  const handleUpload = async () => {
    if (!file) {
      alert("엑셀 파일을 먼저 업로드해 주세요!");
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);

    try {
      const response = await axios.post('/api/monitor/analyze', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        responseType: 'blob', // 서버에서 엑셀 파일(Binary)을 받기 위함
      });

      // 다운로드 링크 생성
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `analysis_result_${Date.now()}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      
      alert("분석이 완료되었습니다. 파일이 다운로드됩니다.");
    } catch (error) {
      console.error("분석 중 오류 발생:", error);
      alert("분석 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '40px', textAlign: 'center' }}>
      <h1>💳 법인카드 부정사용 모니터링</h1>
      <p>엑셀 파일을 업로드하여 자택-가맹점 간 거리를 분석하세요. (기준: 2km)</p>
      
      <div style={{ margin: '20px 0', border: '2px dashed #ccc', padding: '20px' }}>
        <input type="file" accept=".xlsx, .xls" onChange={handleFileChange} />
      </div>

      <button 
        onClick={handleUpload} 
        disabled={loading}
        style={{ padding: '10px 20px', cursor: loading ? 'not-allowed' : 'pointer' }}
      >
        {loading ? '분석 중...' : '분석 시작 및 결과 다운로드'}
      </button>

      {loading && <p>데이터를 분석하고 좌표를 수집하는 중입니다. 잠시만 기다려 주세요...</p>}
    </div>
  );
};

export default App;