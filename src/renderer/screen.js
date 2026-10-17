'use strict';
// 文件页面没有可指定的 HTTP origin；主窗口另行核对 event.source。
window.opener?.postMessage('ydesk-screen-ready', '*');
