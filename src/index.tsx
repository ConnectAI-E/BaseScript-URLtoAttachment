import React, {useEffect,useState} from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import {initI18n} from './i18n'
import {bitable} from '@base-open/web-api'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <LoadApp/>
  </React.StrictMode>
)

function LoadApp() {
  const [load, setLoad] = useState(false);
  const [loadErr, setLoadErr] = useState<any>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoadErr(
        <div>
          运行项目后，请获取 webview 地址，粘贴至多维表格「扩展脚本」中使用。详见：
          <a target='_blank' href='https://bytedance.feishu.cn/docx/HazFdSHH9ofRGKx8424cwzLlnZc'>开发指南</a>
        </div>
      )
    }, 1000)
    bitable.bridge.getLanguage().then((lang) => {
      clearTimeout(timer)
      initI18n(lang as any);
      setLoad(true);
    });
    return () => clearTimeout(timer)
  }, [])

  if (load) {
    return <App />
  }

  return loadErr
}