// 公共浏览器全局桩
function makeProxy(name) {
  const target = function(){ return makeProxy(name + '()'); };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'toString') return () => '[' + name + ']';
      if (prop === 'valueOf') return () => 0;
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'length') return 0;
      if (prop === 'then') return undefined;
      return makeProxy(name + '.' + String(prop));
    },
    apply() { return makeProxy(name + '()'); },
    construct() { return makeProxy('new ' + name); },
    set() { return true; },
    has() { return true; },
  });
}
global.makeProxy = makeProxy;
const browserGlobals = [
  'History','Location','Navigator','Screen','Storage','localStorage','sessionStorage',
  'Event','CustomEvent','MouseEvent','KeyboardEvent','UIEvent','PointerEvent','TouchEvent','WheelEvent','FocusEvent','InputEvent','CompositionEvent','DragEvent','ClipboardEvent','Touch','TouchList',
  'EventTarget','Node','Element','HTMLElement','HTMLDivElement','HTMLCanvasElement','HTMLImageElement','HTMLIFrameElement','HTMLScriptElement','HTMLStyleElement','HTMLHeadElement','HTMLBodyElement','HTMLFormElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLOptionElement','HTMLAnchorElement','HTMLSpanElement','HTMLDocument','Document','DocumentFragment','ShadowRoot','Window','CSSStyleDeclaration','DOMRect','DOMRectReadOnly','Attr','CharacterData','Text','Comment','Option','CanvasRenderingContext2D','ImageBitmap','ImageBitmapRenderingContext',
  'XMLHttpRequest','FormData','FileReader','File','Image','ImageData','OffscreenCanvas','WebGLRenderingContext','WebGL2RenderingContext','CanvasRenderingContext2D','AudioContext','Audio','webkitAudioContext',
  'MutationObserver','ResizeObserver','IntersectionObserver','PerformanceObserver','Performance','performance','Worker','ServiceWorker','WebSocket','MessageChannel','MessagePort','SharedWorker',
  'DOMParser','XMLSerializer','TreeWalker','NodeFilter','Range','Selection',
  'close','open','alert','confirm','prompt','print','stop','focus','blur','scrollTo','scrollBy','scroll','resizeBy','resizeTo','moveBy','moveTo','scrollByLines','scrollByPages','getSelection','matchMedia','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','cancelIdleCallback','addEventListener','removeEventListener','dispatchEvent','postMessage','msWriteProfilerMark','showModalDialog','collectGarbage',
  'devicePixelRatio','innerWidth','innerHeight','outerWidth','outerHeight','screenX','screenY','screenLeft','screenTop','pageXOffset','pageYOffset','scrollX','scrollY','name','length','top','parent','frames','opener','closed','frameElement','self','window','globalThis',
  'indexedDB','IDBRequest','IDBKeyRange','IDBDatabase','IDBOpenDBRequest','IDBTransaction','IDBObjectStore','webkitURL','chrome','onload','onerror','onmessage','webkitIndexedDB',
  'fetch','Headers','Request','Response','ReadableStream','WritableStream','TransformStream',
  'DeviceOrientationEvent','DeviceMotionEvent',
  'CSS','FontFace','FontFaceSet','CookieStore','BatteryManager','NavigatorUAData','Permissions','Notification','VisualViewport','RTCPeerConnection','webkitRTCPeerConnection','MediaStream','MediaDevices','MediaRecorder','SpeechSynthesis','SpeechSynthesisUtterance','Gamepad','SharedArrayBuffer','Atomics','BigInt64Array','BigUint64Array','FinalizationRegistry','WebAssembly','PluginArray','MimeTypeArray','MimeType','Plugin','CanvasCaptureMediaStreamTrack','getSelection','Range','caches','BroadcastChannel','queueMicrotask','reportError',
];
for (const g of browserGlobals) {
  if (typeof global[g] === 'undefined') global[g] = makeProxy(g);
}
global.crypto = { getRandomValues: (a) => { for (let i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*256); return a; }, subtle: makeProxy('crypto.subtle'), randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);}) };
global.window = global;
global.self = global;
global.navigator = makeProxy('navigator');
global.document = makeProxy('document');
global.location = makeProxy('location');
global.screen = makeProxy('screen');
global.history = makeProxy('history');
