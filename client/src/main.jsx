import '@fontsource-variable/archivo/wdth.css'; // Latin display text and figures (width axis 62–125%)
import '@fontsource-variable/heebo'; // Main interface face (Hebrew)
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
