// 远程访问的手机网页入口
import { createRoot } from 'react-dom/client'
import { RemoteApp } from './RemoteApp'
import './remote.css'

createRoot(document.getElementById('root')!).render(<RemoteApp />)
