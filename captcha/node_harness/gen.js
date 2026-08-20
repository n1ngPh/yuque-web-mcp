// 通用生成器：arg / trackId / data（复用 sg.090.js 的 VM 字节码解释器）
// 用法：
//   node gen.js arg <rand16>            -> 输出 16 字符 base64 arg
//   node gen.js trackid <ncJsonStr>     -> 输出 32 hex trackId
//   node gen.js data <ncJsonStr>        -> 输出 {"trackId":..,"data":..}
const fs = require('fs');
const zlib = require('zlib');
const CryptoJS = require('crypto-js');
require('./stubs.js');
global.__ALIYUN_CRYPT = CryptoJS;

let src = fs.readFileSync(__dirname + '/../js_src/sg.090.js', 'utf8');
const ANCHOR = '"charCodeAt"];e(655),e(1465),e(4845),e(5729),e(1381),e(8977),e(4438);var q=e(4019)';
const INJECT = '"charCodeAt"];window.__VM={D:D,U:U,L:L,R:R,F:F};e(655),e(1465),e(4845),e(5729),e(1381),e(8977),e(4438);var q=e(4019)';
if (!src.includes(ANCHOR)) { console.error('ANCHOR 未命中'); process.exit(1); }
src = src.replace(ANCHOR, INJECT);
const fn = new Function('window','self','document','navigator','NodeList','location','crypto','atob','btoa','screen','history','XMLHttpRequest','localStorage','sessionStorage','fetch','performance','Image','Event','CustomEvent','MutationObserver','Worker','Blob','URL','TextEncoder','getComputedStyle','matchMedia','requestAnimationFrame','close','__ALIYUN_CRYPT', src);
fn(global.window, global.self, global.document, global.navigator, function(){}, global.location, global.crypto, global.atob, global.btoa, global.screen, global.history, global.XMLHttpRequest, global.localStorage, global.sessionStorage, global.fetch, global.performance, global.Image, global.Event, global.CustomEvent, global.MutationObserver, global.Worker, global.Blob, global.URL, global.TextEncoder, global.getComputedStyle, global.matchMedia, global.requestAnimationFrame, global.close, global.__ALIYUN_CRYPT);

const VM = global.__VM;
const DATA_KEY = '3e627e1b4c63f913';
const ARG_CONST = '15RTmkUFuA';
const OPT = {r: 1};

function genArg(rand16) {
  return VM.D(0, [], VM.U, VM.L, OPT, [ARG_CONST, rand16]);
}
function genTrackId(ncJsonStr) {
  return VM.D(0, [], VM.R, VM.F, OPT, [ncJsonStr, '0000']);
}
function genData(ncJsonStr) {
  const trackId = genTrackId(ncJsonStr);
  const plain = trackId + ncJsonStr;
  const compressed = zlib.deflateSync(Buffer.from(plain, 'utf8'));
  const o0 = Buffer.from(compressed).toString('base64');
  const data = VM.D(0, [], VM.U, VM.L, OPT, [o0, DATA_KEY]);
  return { trackId, data };
}

const mode = process.argv[2];
const payload = process.argv[3] || '';
if (mode === 'arg') console.log(genArg(payload));
else if (mode === 'trackid') console.log(genTrackId(payload));
else if (mode === 'data') console.log(JSON.stringify(genData(payload)));
else console.error('用法: node gen.js <arg|trackid|data> <payload>');
module.exports = { VM, genArg, genTrackId, genData, DATA_KEY, ARG_CONST, OPT };
