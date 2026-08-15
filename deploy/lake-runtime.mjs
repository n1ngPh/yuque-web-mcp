import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const base = "https://gw.alipayobjects.com/os/chair-script/skylark";
const assets = [
  [
    "pc.2188dd6d.js",
    "210fd8f048ffbef8c6a67b5f495fad689adab1fad7c81b4b06d2ce11f8d405c1",
  ],
  [
    "deps.3c2b2e32.js",
    "bf4af19022bff57ab581c2496ef64e22402ca5533ce9221b2f0a09d95cafd9f7",
  ],
  [
    "larkui.9c780393.js",
    "b433193ea63b60ce879582c9241d107431474169fac154150c98fc2131aa12c3",
  ],
  [
    "common.d114c29e.js",
    "a571bbb294c6f89b2828d0c55ad6751d1bd7f27e76efdeee8eae22e0c9521fc4",
  ],
  [
    "lake_common.ce9c85df.async.js",
    "4ac1c145fd5c9a135fed5371675410d7c6d8c88349b38b8765de601e7ef51a03",
  ],
  [
    "51679.eed10a3b.async.js",
    "d5c5842bbdea70e9d6b84257c152aa312744427d92c0abe2438f03e4e7d99918",
  ],
  [
    "75811.0b55d8ac.async.js",
    "9ee081b008f4c1c3f9af503adb34af496f5d0c8dfae13af9e463327fcc0dc792",
  ],
  [
    "doc_editor.725cb3a8.async.js",
    "b37627e1337c963ceacd9ea02c9f1a69a38e0a1a5aeebb5dfc7263ab88df37a1",
  ],
  [
    "lakex_table_yq.2b239745.async.js",
    "fff774a968b639c3d2d8e9c5bf0476ad4b8d243acb8d79192235e8e7683d9dcb",
  ],
  [
    "17328.778a4055.async.js",
    "bae7b824d7703e92f2dcaefed1bc60e8689905d478f8391fb94280cd2f240673",
  ],
  [
    "18660.d6f54bce.async.js",
    "6b9df221921e507b635ec60b4d5f4461ae3373ad5031e787d09f5a9f19e32a91",
  ],
  [
    "19445.c2eec333.async.js",
    "85cc460b7b8e63e133b5b64d07aab32e1dec9e283ac15797a79032fc6cdf077b",
  ],
  [
    "20656.fcaae90b.async.js",
    "dc769d1e5010010d7d3dc4fa6e6f148d2c08721d778c647a5292edfa683999d1",
  ],
  [
    "21172.2072676a.async.js",
    "2b0fccf3aa840398c728a058325831c2787211fcb17b14ccb20e24f29f5b701a",
  ],
  [
    "28062.9fc60e23.async.js",
    "b11148e86f05b43d3c80573baeac2fae7c4f04ea3ed20f737c72795e6f285437",
  ],
  [
    "30105.9300ab22.async.js",
    "4d34bda21a814621aa94a8b0dc4363905b598c6d8f2acecbda1403d505e75a4c",
  ],
  [
    "38100.985942cc.async.js",
    "17acc491cc6b5813fc6b00c8ecc714c8c8ade0f9c22928c4440dafe4d8fc230e",
  ],
  [
    "44635.de26460c.async.js",
    "2a5cb2dd48a554ee76dbed34486bf5534548c4820d54bf9f5128d7b101780709",
  ],
  [
    "4685.b489f9de.async.js",
    "cf86faf8b07a9033f3c7f4e19708df6020df276e47b434c2ccf65cf45ee9a047",
  ],
  [
    "53950.b8e35396.async.js",
    "786cc0570ca5acccfadd625a8bcc9dbd146cb5efa0c9adb1970e8be41d70654e",
  ],
  [
    "56950.a7bcf5b0.async.js",
    "82ad0d97fe70f5db3a8a53d1d8aedc8241d8d33600b27298659f226f903e3b74",
  ],
  [
    "58820.b77887b6.async.js",
    "fd3bd7e0260c78c19cfa5cc7d16c889b4af17b178235d272884ad2f66c26492a",
  ],
  [
    "62479.d9237568.async.js",
    "1ed571de44e5e6f3ff30bc2a72984cb5747350abe4d94a950a8df3e197a1f086",
  ],
  [
    "65610.a9e5ab72.async.js",
    "5d7f46aa33aab8bfa854773bcc3f3dab961fa8f1ab6099d80d4e6b4725532bf9",
  ],
  [
    "67771.f3dbde34.async.js",
    "49aeeac0921d0fc1100000c082247c94ec840f1439d6604a544b68689df372e1",
  ],
  [
    "67896.7d1f2050.async.js",
    "3b4c919b1edb701205b164b0c67d777deb8b446eff0df942e846cb6151765c22",
  ],
  [
    "7530.6f026047.async.js",
    "1579c1ac4ae8a8e590e5e9436559e31c9ce172154bfe5a1ab5571592f0476eb2",
  ],
  [
    "78577.8753735d.async.js",
    "b2fda4315dc7aca18a4a5145d653c8c0efbbaa91aa729406fa57d99a715c4c47",
  ],
  [
    "86858.b3351815.async.js",
    "f3e2050ede474e5b5b0b1364ea05d853619c5b6853bf6861ccaad41d2514fae8",
  ],
  [
    "91558.33d3b38c.async.js",
    "cf1d32fb131322f74334932445a55b39391189812cb3829b4cd3960238ad3393",
  ],
  [
    "93576.e038d75b.async.js",
    "098a9a7e67f5a7eb5fdf6017ca28050f9441b3d442a2977144c3f8c3bd2350a5",
  ],
  [
    "97097.205b5f98.async.js",
    "babf85f567ebe4c7da0e0bcf58f161079afa39d6a93d13365105e8b1e8fb19e7",
  ],
  [
    "c__Icons655.d1eda67a.async.js",
    "9f76ab826664fc923453b1d9d5fa5df4ab489b893e78aa355e74a80890e2e0f4",
  ],
];

const bundleManifestPath = process.env.LAKE_RESEARCH_BUNDLE_MANIFEST;
if (bundleManifestPath) {
  const manifest = JSON.parse(await readFile(bundleManifestPath, "utf8"));
  const known = new Set(assets.map(([name]) => name));
  for (const bundle of Array.isArray(manifest.bundles)
    ? manifest.bundles
    : []) {
    if (
      typeof bundle?.url !== "string" ||
      typeof bundle?.sha256 !== "string" ||
      !bundle.url.startsWith(`${base}/`)
    ) {
      continue;
    }
    const name = new URL(bundle.url).pathname.split("/").at(-1);
    if (!name?.endsWith(".js") || known.has(name)) continue;
    known.add(name);
    assets.push([name, bundle.sha256]);
  }
}

const sources = new Map();
let assetCursor = 0;
await Promise.all(
  Array.from({ length: Math.min(12, assets.length) }, async () => {
    while (assetCursor < assets.length) {
      const [name, expectedSha256] = assets[assetCursor++];
      const response = await fetch(`${base}/${name}`);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch fixed bundle ${name}: ${response.status}`,
        );
      }
      const source = await response.text();
      const actualSha256 = createHash("sha256").update(source).digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(`Fixed bundle fingerprint changed for ${name}`);
      }
      sources.set(name, source);
    }
  }),
);

const runtimeName = "pc.2188dd6d.js";
const runtime = sources.get(runtimeName);
if (!runtime) throw new Error("Fixed Skylark runtime is missing");
const entry =
  'l.O(void 0,["98062","84978","35005"],()=>l(892459));var h=l.O(void 0,["98062","84978","35005"],()=>l(279988));h=l.O(h)})();';
if (!runtime.endsWith(entry)) {
  throw new Error("Fixed Skylark runtime bootstrap no longer matches");
}

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.__skylark_required_modules__ = new Set();
const requireCall =
  "return c[e].call(r.exports,r,r.exports,l),r.loaded=!0,r.exports";
const guardedRuntime = runtime
  .slice(0, -entry.length)
  .replace(
    requireCall,
    `globalThis.__skylark_required_modules__.add(e);if(!c[e])throw new Error("Missing Skylark module "+e);${requireCall}`,
  );
if (!guardedRuntime.includes("Missing Skylark module")) {
  throw new Error("Fixed Skylark module loader no longer matches");
}
vm.runInThisContext(`${guardedRuntime}globalThis.__skylark_require__=l})();`, {
  filename: runtimeName,
});
const moduleOrigins = new Map();
for (const id of Object.keys(globalThis.__skylark_require__.m ?? {})) {
  moduleOrigins.set(Number(id), runtimeName);
}
for (const [name] of assets.slice(1)) {
  const knownModules = new Set(
    Object.keys(globalThis.__skylark_require__.m ?? {}),
  );
  vm.runInThisContext(sources.get(name), { filename: name });
  for (const id of Object.keys(globalThis.__skylark_require__.m ?? {})) {
    if (!knownModules.has(id)) moduleOrigins.set(Number(id), name);
  }
}

const skylarkRequire = globalThis.__skylark_require__;
if (typeof skylarkRequire !== "function") {
  throw new Error("Skylark module loader was not exposed");
}
const syntheticInput = "<!doctype lake><p>synthetic-probe</p>";
const legacyLakeToHtml = skylarkRequire(168624);
const legacyHtml = legacyLakeToHtml(syntheticInput);
const workerProbe = { instances: 0, messages: 0 };
let personalNativeComparison = null;
const result = {
  scope:
    process.env.PERSONAL_LAKE_COMPARE === "1"
      ? "personal_test_book_read_only"
      : "synthetic_fixed_bundle_only",
  yuque_host_requested: process.env.PERSONAL_LAKE_COMPARE === "1",
  company_host_requested: false,
  browser_started: false,
  fixed_bundle_count: assets.length,
  legacy_converter_available:
    typeof legacyHtml === "string" && legacyHtml.length > 0,
  legacy_output_contains_probe:
    typeof legacyHtml === "string" && legacyHtml.includes("synthetic-probe"),
};

if (process.env.PERSONAL_LAKE_COMPARE === "1") {
  await loadPrivateEnvironment(join(projectRoot, "runtime", "local.env"));
  const { loadConfig } = await import(join(projectRoot, "dist/src/config.js"));
  const { createApplication } = await import(
    join(projectRoot, "dist/src/app.js")
  );
  const app = await createApplication(loadConfig());
  try {
    const personalOrigin = new URL(app.config.personalYuqueHost).origin;
    if (personalOrigin !== "https://www.yuque.com") {
      throw new Error("Personal Lake comparison requires www.yuque.com");
    }
    const books = await app.client.listAllBooks(app.config.ownerId, "personal");
    const matchingBooks = books.filter((book) => book.name === "测试知识库");
    if (matchingBooks.length !== 1) {
      throw new Error("Expected exactly one personal 测试知识库");
    }
    const toc = await app.client.getToc(
      app.config.ownerId,
      matchingBooks[0].url,
    );
    const matchingDocs = toc.nodes.filter(
      (node) => node.title === "test_创建文档" && node.docUrl,
    );
    if (matchingDocs.length !== 1 || !matchingDocs[0].docUrl) {
      throw new Error("Expected exactly one personal test_创建文档");
    }
    const native = await app.client.getDocEditorDraft(
      app.config.ownerId,
      matchingDocs[0].docUrl,
    );
    const generated = legacyLakeToHtml(native.publishedAsl);
    personalNativeComparison = {
      asl: native.publishedAsl,
      html: native.publishedHtml,
    };
    Object.assign(result, {
      display_path: native.location.displayPath,
      doc_url: native.url,
      version: native.version,
      native_asl_characters: native.publishedAsl.length,
      native_html_characters: native.publishedHtml.length,
      legacy_html_characters: generated.length,
      legacy_matches_native_html: generated === native.publishedHtml,
      legacy_hash_matches_native:
        createHash("sha256").update(generated).digest("hex") ===
        createHash("sha256").update(native.publishedHtml).digest("hex"),
      write_sent: false,
    });
  } finally {
    app.db.close();
  }
}

if (process.env.LAKE_EDITOR_RUNTIME_PROBE !== "1") {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

try {
  const researchModules = process.env.LAKE_RESEARCH_NODE_MODULES;
  const researchRequire = createRequire(
    researchModules
      ? `${researchModules}/package.json`
      : join(projectRoot, "package.json"),
  );
  const { parseHTML } = researchRequire("linkedom");
  const { window: domWindow } = parseHTML(
    "<!doctype html><html><body></body></html>",
  );
  const syntheticLocation = new URL("https://www.yuque.com/");
  Object.defineProperty(domWindow, "location", {
    configurable: true,
    value: syntheticLocation,
  });
  Object.defineProperty(domWindow.document, "location", {
    configurable: true,
    value: syntheticLocation,
  });
  Object.defineProperty(domWindow.document, "cookie", {
    configurable: true,
    writable: true,
    value: "",
  });
  globalThis.window = domWindow;
  globalThis.document = domWindow.document;
  const syntheticNavigator = {
    language: "zh-CN",
    languages: ["zh-CN"],
    platform: "MacIntel",
    userAgent: "Node.js Yuque Lake research probe",
    maxTouchPoints: 0,
  };
  Object.defineProperty(domWindow, "navigator", {
    configurable: true,
    value: syntheticNavigator,
  });
  const syntheticScreen = {
    availHeight: 900,
    availWidth: 1440,
    height: 900,
    width: 1440,
  };
  Object.defineProperty(domWindow, "screen", {
    configurable: true,
    value: syntheticScreen,
  });
  Object.defineProperty(globalThis, "screen", {
    configurable: true,
    value: syntheticScreen,
  });
  domWindow.innerHeight = 900;
  domWindow.innerWidth = 1440;
  domWindow.devicePixelRatio = 1;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: syntheticNavigator,
  });
  const createMemoryStorage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(String(key)) ?? null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
      clear: () => values.clear(),
    };
  };
  globalThis.localStorage = createMemoryStorage();
  globalThis.sessionStorage = createMemoryStorage();
  domWindow.localStorage = globalThis.localStorage;
  domWindow.sessionStorage = globalThis.sessionStorage;
  for (const name of [
    "Node",
    "Element",
    "HTMLElement",
    "DOMParser",
    "MutationObserver",
    "CustomEvent",
    "Event",
  ]) {
    if (domWindow[name]) globalThis[name] = domWindow[name];
  }
  Object.defineProperty(domWindow.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
    set(value) {
      this.textContent = String(value);
    },
  });
  globalThis.React = researchRequire("react");
  globalThis.ReactDOM = researchRequire("react-dom");
  globalThis.moment = researchRequire("moment");
  globalThis.CodeMirror = researchRequire("codemirror");
  domWindow.React = globalThis.React;
  domWindow.ReactDOM = globalThis.ReactDOM;
  domWindow.moment = globalThis.moment;
  domWindow.CodeMirror = globalThis.CodeMirror;
  class SyntheticWorker {
    constructor() {
      workerProbe.instances += 1;
      this.onmessage = null;
      this.onerror = null;
    }

    addEventListener() {}

    removeEventListener() {}

    postMessage() {
      workerProbe.messages += 1;
    }

    terminate() {}
  }
  globalThis.Worker = SyntheticWorker;
  domWindow.Worker = SyntheticWorker;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
  globalThis.React = skylarkRequire(41594);
  const lake = skylarkRequire(38297);
  if (typeof lake.lakeToHtml !== "function") {
    throw new Error("Fixed Doc editor no longer exports lakeToHtml");
  }
  const html = lake.lakeToHtml(syntheticInput, { includeMeta: true });
  if (process.env.LAKE_CONVERT_STDIN === "1") {
    const serialized = await readStdin();
    const input = JSON.parse(serialized);
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.asl !== "string" ||
      !/^\s*<!doctype lake>/i.test(input.asl) ||
      input.asl.length > 5_000_000
    ) {
      throw new Error("Lake conversion input is invalid or too large");
    }
    const generated = lake.lakeToHtml(input.asl);
    if (typeof generated !== "string" || !generated) {
      throw new Error("Fixed Doc editor returned empty HTML");
    }
    const bodyHtml = /^<!doctype html>/i.test(generated)
      ? generated
      : `<!doctype html>${generated}`;
    process.stdout.write(`${JSON.stringify({ body_html: bodyHtml })}\n`);
    process.exit(0);
  }
  const personalEditorComparisons = {};
  let editorGeneratedDefault = null;
  if (personalNativeComparison) {
    for (const [name, options] of [
      ["default", undefined],
      ["include_meta", { includeMeta: true }],
      ["without_meta", { includeMeta: false }],
    ]) {
      const generated =
        options === undefined
          ? lake.lakeToHtml(personalNativeComparison.asl)
          : lake.lakeToHtml(personalNativeComparison.asl, options);
      if (name === "default") editorGeneratedDefault = generated;
      personalEditorComparisons[`editor_${name}_html_characters`] =
        generated.length;
      personalEditorComparisons[`editor_${name}_matches_native_html`] =
        generated === personalNativeComparison.html;
      personalEditorComparisons[`editor_${name}_hash_matches_native`] =
        createHash("sha256").update(generated).digest("hex") ===
        createHash("sha256")
          .update(personalNativeComparison.html)
          .digest("hex");
    }
    const describeHtml = (source) => {
      const container = globalThis.document.createElement("div");
      container.innerHTML = source;
      const elements = Array.from(container.querySelectorAll("*"));
      return {
        serialized: container.innerHTML,
        text: container.textContent ?? "",
        tags: elements.map((element) => element.tagName.toLowerCase()),
        attributes: elements.map((element) =>
          Array.from(element.attributes)
            .map((attribute) => attribute.name)
            .sort(),
        ),
        attributeValues: elements.map((element) =>
          Object.fromEntries(
            Array.from(element.attributes).map((attribute) => [
              attribute.name,
              attribute.value,
            ]),
          ),
        ),
      };
    };
    const nativeDescription = describeHtml(personalNativeComparison.html);
    const generatedDescription = describeHtml(editorGeneratedDefault);
    const attributeDifferences = [];
    const comparableElements = Math.min(
      nativeDescription.attributeValues.length,
      generatedDescription.attributeValues.length,
    );
    for (let index = 0; index < comparableElements; index += 1) {
      const names = new Set([
        ...Object.keys(nativeDescription.attributeValues[index]),
        ...Object.keys(generatedDescription.attributeValues[index]),
      ]);
      for (const name of names) {
        const nativeValue = nativeDescription.attributeValues[index][name];
        const generatedValue =
          generatedDescription.attributeValues[index][name];
        if (nativeValue === generatedValue) continue;
        attributeDifferences.push({
          element_index: index,
          tag:
            nativeDescription.tags[index] ?? generatedDescription.tags[index],
          name,
          native_present: nativeValue !== undefined,
          generated_present: generatedValue !== undefined,
          native_characters: nativeValue?.length ?? 0,
          generated_characters: generatedValue?.length ?? 0,
        });
      }
    }
    Object.assign(personalEditorComparisons, {
      editor_native_has_html_doctype: /^<!doctype html>/i.test(
        personalNativeComparison.html,
      ),
      editor_generated_has_html_doctype: /^<!doctype html>/i.test(
        editorGeneratedDefault,
      ),
      editor_with_html_doctype_matches_native:
        `<!doctype html>${editorGeneratedDefault}` ===
        personalNativeComparison.html,
      editor_text_matches_native:
        nativeDescription.text === generatedDescription.text,
      editor_dom_serialization_matches_native:
        nativeDescription.serialized === generatedDescription.serialized,
      editor_native_text_characters: nativeDescription.text.length,
      editor_generated_text_characters: generatedDescription.text.length,
      editor_tag_sequence_matches_native:
        JSON.stringify(nativeDescription.tags) ===
        JSON.stringify(generatedDescription.tags),
      editor_attribute_name_shape_matches_native:
        JSON.stringify(nativeDescription.attributes) ===
        JSON.stringify(generatedDescription.attributes),
      editor_attribute_difference_count: attributeDifferences.length,
      editor_attribute_differences: attributeDifferences.slice(0, 20),
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      lake_to_html_available: typeof html === "string" && html.length > 0,
      worker_instances: workerProbe.instances,
      worker_messages: workerProbe.messages,
      output_characters: typeof html === "string" ? html.length : 0,
      output_contains_probe:
        typeof html === "string" && html.includes("synthetic-probe"),
      required_module_count: globalThis.__skylark_required_modules__.size,
      required_bundle_names: Array.from(
        new Set(
          Array.from(globalThis.__skylark_required_modules__)
            .map((id) => moduleOrigins.get(id))
            .filter(Boolean),
        ),
      ).sort(),
      ...personalEditorComparisons,
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      lake_to_html_available: false,
      worker_instances: workerProbe.instances,
      worker_messages: workerProbe.messages,
      failure_name:
        error && typeof error === "object" ? error.constructor?.name : "Error",
      failure_message:
        error && typeof error === "object" && "message" in error
          ? String(error.message).slice(0, 256)
          : "unknown_error",
      failure_stack:
        error && typeof error === "object" && "stack" in error
          ? String(error.stack).split("\n").slice(0, 8)
          : [],
    })}\n`,
  );
  process.exitCode = 1;
}

async function loadPrivateEnvironment(path) {
  const serialized = await readFile(path, "utf8");
  for (const line of serialized.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    process.env[line.slice(0, separator)] = line.slice(separator + 1);
  }
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 10_000_000) {
      throw new Error("Lake conversion input is too large");
    }
  }
  return value;
}
