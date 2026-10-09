import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { Developer } from './components/Developer';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{import.meta.env.DEV && window.location.pathname === '/dev' ? <Developer /> : <App />}</React.StrictMode>);
