/// <reference types="vite/client" />

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<Electron.WebviewTag>, Electron.WebviewTag> & {
      src?: string;
      partition?: string;
      preload?: string;
      allowpopups?: boolean;
      nodeintegration?: boolean;
      webpreferences?: string;
    };
  }
}
