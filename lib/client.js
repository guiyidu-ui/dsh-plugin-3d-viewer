// dsh-plugin-3d-viewer — client half (browser bundle).
//
// Turns `3d` code blocks and `[3d:path]` links in assistant messages into
// inline, interactive 3D viewers (Three.js): drag to orbit, wheel to zoom,
// right-drag to pan, double-click to reset view. The model file is fetched
// from the same-origin /model3d/ host route (host half reads it from the
// session workspace), so no file:// or external CDN is involved at render
// time.
//
// Three.js is loaded ON DEMAND from the jsDelivr ESM CDN when the first 3d
// block appears (script tag + dynamic import, ~600 KB, browser-cached).
// While loading a spinner hint is shown; on CDN failure a fallback hint with
// a plain open-in-new-tab link to the same /model3d/ URL is shown, so the
// model stays reachable even offline.
//
// Inline detection (document-level MutationObserver, same pattern as
// image-lightbox's dblclick capture):
//   * <pre> whose first <code> carries a language-3d class token — the code
//     body is a (possibly multi-line) absolute model path; the first
//     non-empty line that matches an absolute path with a known extension
//     wins.
//   * <a href="/model3d/..."> — [3d:path] markdown links.
// Both are replaced in place by a viewer host element; the host carries
// data-dsv3d so re-runs (React re-render, scroll re-mount) are idempotent.
//
// Note: if the message DOM is re-created by the chat renderer the viewer is
// re-mounted from scratch (fresh fetch of the same /model3d/ URL). Cheap for
// our file sizes; no cross-render cache.

window.__ModuleLoader__.load({
  id: "dsh-plugin-3d-viewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var EXT_RE = /\.(obj|stl|gltf|glb)$/i;
    var MODEL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\|\/)[^\r\n"']+/;
    var THREE_VERSION = "0.170.0";
    // 2026-10-02：多源兜底。原先只挂 jsDelivr 一个源，CDN 一抖动整个插件就只剩
    // 降级提示。实测（本机全权令牌）jsDelivr 1.27 s / 1.31 MB，npmmirror
    // 1.09 s（国内镜像，更稳）。按顺序探测，第一个成功的源被记住，
    // examples/jsm 下的加载器也走同一个源。
    var THREE_BASES = [
      "https://cdn.jsdelivr.net/npm/three@" + THREE_VERSION,
      "https://registry.npmmirror.com/three/" + THREE_VERSION + "/files",
      "https://unpkg.com/three@" + THREE_VERSION
    ];
    var threeBase = null;
    var disposables = []; // live viewer hosts, torn down on plugin disposal
    var liveViewers = []; // live viewer instances {host, dispose}; the 2s self-heal scan reclaims ones whose host was removed from the DOM

    // Absolute display path (Windows or POSIX) -> /model3d/<encoded> URL.
    //   D:\models\demo.obj  ->  /model3d/E:/AI%20share/models/demo.obj
    //   /srv/models/demo.gltf        ->  /model3d/srv/models/demo.gltf
    function modelUrl(absPath) {
      var raw = absPath.replace(/\\/g, "/").replace(/^\/+/, "");
      var drive = /^[A-Za-z]:/.exec(raw);
      var enc = raw
        .split("/")
        .map(function (seg) { return encodeURIComponent(seg); })
        .join("/");
      if (drive) return "/model3d/" + enc.replace("%3A", ":");
      return "/model3d/" + enc;
    }

    var threePromise = null;

    // 2026-10-08 修复②：原实现先插一个 <script src=three.module.js>（经典脚本）
    // 再 import() 同一个 URL。three.module.js 是 ESM，经典脚本执行必然抛
    // "Unexpected token 'export'"（等于白下载 1.3 MB），且 script 加载没有超时，
    // CDN 挂住时会一直转圈。现在只用动态 import()，并加 8 秒超时。
    var THREE_TIMEOUT_MS = 8000;

    function tryBase(base) {
      var url = base + "/build/three.module.js";
      var timer = null;
      var timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error("three.js 源超时: " + base)); }, THREE_TIMEOUT_MS);
      });
      return Promise.race([
        import(url).then(function (mod) { return { base: base, mod: mod }; }),
        timeout
      ]).then(
        function (hit) { if (timer) clearTimeout(timer); return hit; },
        function (err) { if (timer) clearTimeout(timer); throw err; }
      );
    }

    function loadThree() {
      if (threePromise) return threePromise;
      var bases = threeBase !== null ? [threeBase].concat(THREE_BASES) : THREE_BASES.slice();
      threePromise = bases
        .reduce(function (chain, base) {
          return chain.catch(function () { return tryBase(base); });
        }, Promise.reject(new Error("no three.js source")))
        .then(function (hit) {
          threeBase = hit.base;
          return hit.mod;
        })
        .catch(function (err) {
          threePromise = null;
          throw err;
        });
      return threePromise;
    }

    // ===== 2026-10-08 修复③：模型一直显示不出来的真因 =====
    // three.js 的 examples/jsm 加载器（OBJLoader / STLLoader / GLTFLoader）源码里
    // 写的是**裸模块名** `import { ... } from 'three'`（GLTFLoader 还 import 相对
    // 路径的 ../utils/BufferGeometryUtils.js，那个文件里同样有裸名 'three'）。
    // 浏览器没有 import map 就报：
    //   TypeError: Failed to resolve module specifier "three"
    // → **任何 obj/stl/gltf/glb 模型都显示不出来**，界面只留一句"模型加载失败"。
    // 旧版「先插 <script src=three.module.js> 再 import()」的写法解决不了这个问题。
    // 做法：把加载器源码取回来 → 把 'three' 改写成 CDN 绝对 URL（与渲染器**同一份**
    // 模块实例，保证 instanceof 等判断正常）→ 相对依赖递归改写 → blob URL 动态 import。
    // 无需 import map；实测本页无 CSP，blob 与嵌套 blob 均可 import。
    var moduleUrlCache = {};

    function replaceSpecifier(src, spec, url) {
      var esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return src.replace(new RegExp("([\"'])" + esc + "\\1", "g"), function (m, q) {
        return q + url + q;
      });
    }

    function loadPatchedModule(absUrl, base, depth) {
      if (moduleUrlCache[absUrl]) return moduleUrlCache[absUrl];
      var p = fetch(absUrl)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status + " " + absUrl);
          return r.text();
        })
        .then(function (src) {
          var dir = absUrl.slice(0, absUrl.lastIndexOf("/") + 1);
          var specs = [];
          var re = /(\bfrom\s*|\bimport\s*)(["'])([^"']+)\2/g;
          var m;
          while ((m = re.exec(src)) !== null) {
            if (specs.indexOf(m[3]) === -1) specs.push(m[3]);
          }
          var threeUrl = base + "/build/three.module.js";
          var chain = Promise.resolve();
          specs.forEach(function (spec) {
            var target = null;
            if (spec === "three") target = threeUrl;
            else if (/^\.{1,2}\//.test(spec)) target = new URL(spec, dir).href;
            if (target === null) return;
            if (target === threeUrl) {
              // three 本体直接用原 URL，保证与渲染器是同一个模块实例
              src = replaceSpecifier(src, spec, target);
              return;
            }
            if (depth >= 4) throw new Error("加载器依赖层级过深: " + spec);
            chain = chain.then(function () {
              return loadPatchedModule(target, base, depth + 1).then(function (blobUrl) {
                src = replaceSpecifier(src, spec, blobUrl);
              });
            });
          });
          return chain.then(function () {
            return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
          });
        });
      moduleUrlCache[absUrl] = p;
      return p;
    }

    var exampleCache = {};
    function loadExample(rel) {
      if (exampleCache[rel]) return exampleCache[rel];
      var base = threeBase !== null ? threeBase : THREE_BASES[0];
      exampleCache[rel] = loadPatchedModule(base + "/examples/jsm/" + rel, base, 0)
        .then(function (u) { return import(u); })
        .catch(function (e) { delete exampleCache[rel]; throw e; });
      return exampleCache[rel];
    }

    // Build the interactive viewer DOM for one model URL.
    function makeViewerHost(src, absPath, options) {
      var opts = options || {};
      var host = document.createElement("div");
      host.setAttribute("data-dsv3d", "1");
      if (opts.inPanel) host.setAttribute("data-dsv3d-panel-viewer", "1");
      host.style.cssText =
        "position:relative;margin:10px 0;border-radius:12px;overflow:hidden;" +
        "background:radial-gradient(120% 120% at 30% 20%, #1b2030 0%, #0b0e16 70%);" +
        "border:1px solid rgba(255,255,255,0.14);cursor:grab;user-select:none;" +
        "width:100%;height:" + (opts.fill ? "100%" : "420px") + ";" +
        (opts.fill ? "" : "max-width:760px;");

      var hint = document.createElement("div");
      hint.textContent = "\u8f7d\u5165 3D \u5f15\u64ce\u4e2d\u2026";
      hint.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
        "color:rgba(255,255,255,0.75);font-size:13px;" +
        "font-family:system-ui,'Microsoft YaHei',sans-serif;pointer-events:none;";
      host.appendChild(hint);

      var bar = document.createElement("div");
      bar.textContent = "\u62d6\u62fd\u65cb\u8f6c \u00b7 \u6eda\u8f6e\u7f29\u653e \u00b7 \u53f3\u952e\u62d6\u52a8\u5e73\u79fb \u00b7 \u53cc\u51fb\u91cd\u7f6e\u89c6\u89d2";
      bar.style.cssText =
        "position:absolute;left:10px;bottom:8px;color:rgba(255,255,255,0.45);font-size:11px;" +
        "font-family:system-ui,'Microsoft YaHei',sans-serif;pointer-events:none;";
      host.appendChild(bar);

      var open = document.createElement("a");
      // 2026-10-08 真凶修复：这个链接的 href 也是 /model3d/...，必须显式标记为
      // 「不是 3D 触发点」，否则扫描器会把它当成新的 3D 块去挂载查看器。
      open.setAttribute("data-dsv3d-skip", "1");
      open.textContent = absPath.length > 60 ? "\u2026" + absPath.slice(-57) : absPath;
      open.href = src;
      open.target = "_blank";
      open.rel = "noopener";
      open.style.cssText =
        "position:absolute;right:10px;bottom:8px;max-width:55%;overflow:hidden;text-overflow:ellipsis;" +
        "white-space:nowrap;color:rgba(255,255,255,0.4);font-size:11px;text-decoration:none;" +
        "font-family:ui-monospace,Consolas,monospace;";
      host.appendChild(open);

      // 2026-10-09 新增：一键把当前模型送到右侧栏常驻预览（面板里不重复显示该按钮）
      if (!opts.inPanel) {
        var side = document.createElement("button");
        side.type = "button";
        side.setAttribute("data-dsv3d-skip", "1");
        side.setAttribute("data-dsv3d-sidebar", "1");
        side.textContent = "\u4fa7\u680f\u9884\u89c8";
        side.style.cssText =
          "position:absolute;right:10px;top:8px;z-index:2;cursor:pointer;" +
          "background:rgba(255,255,255,0.10);color:rgba(255,255,255,0.85);" +
          "border:1px solid rgba(255,255,255,0.22);border-radius:6px;font-size:11px;" +
          "padding:2px 8px;font-family:system-ui,'Microsoft YaHei',sans-serif;";
        side.addEventListener("click", function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          if (ev && ev.stopPropagation) ev.stopPropagation();
          openInPanel(absPath, src);
        });
        host.appendChild(side);
      }

      // ===== 2026-10-07 冻结修复重写 =====
      // 旧版是无限 60fps rAF 循环 + 每帧 resize/render，且 React 重挂载后
      // 孤儿循环无人清理，WebGL 上下文（浏览器上限约 16）耗尽后拖垮 GPU 进程
      // （桌面端/网页端整窗无响应）。
      // 新版：按需渲染（相机变化/模型加载/窗口缩放/滚回视野时才画一帧）、
      // IntersectionObserver 视口不可见时跳过渲染、dispose() 完整释放上下文
      // 与事件监听、liveViewers 注册 + apply() 2 秒自愈扫描回收 DOM 移除的孤儿。
      var disposed = false;
      var renderer = null;
      var scene = null;
      var camera = null;
      var group = null;
      var io = null;
      var raf = 0;
      var renderQueued = false;
      var inView = true;
      var lastW = 0;
      var lastH = 0;
      var dragging = 0;
      var st = { target: null, theta: 0.6, phi: 1.15, radius: 3, home: null };

      function showFail(msg) { hint.textContent = msg; }

      // 按需渲染：任何变化调用一次，最多排一个 rAF
      function requestRender() {
        if (disposed || renderQueued) return;
        renderQueued = true;
        raf = requestAnimationFrame(doFrame);
      }
      function doFrame() {
        renderQueued = false;
        if (disposed || !renderer || !camera || !st.target) return;
        if (!inView) return; // 视口不可见：不画，等 IntersectionObserver 唤醒
        var w = host.clientWidth || 300, h = host.clientHeight || 200;
        if (w !== lastW || h !== lastH) {
          lastW = w; lastH = h;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        }
        camera.position.set(
          st.target.x + st.radius * Math.sin(st.phi) * Math.sin(st.theta),
          st.target.y + st.radius * Math.cos(st.phi),
          st.target.z + st.radius * Math.sin(st.phi) * Math.cos(st.theta)
        );
        camera.lookAt(st.target);
        renderer.render(scene, camera);
        // 拖拽中续下一帧（60fps）；未拖拽到此为止（空闲 0% GPU）
        if (dragging) requestRender();
      }

      function onWinResize() { requestRender(); }
      window.addEventListener("resize", onWinResize);

      function dispose() {
        if (disposed) return;
        disposed = true;
        if (io) { try { io.disconnect(); } catch (e) {} io = null; }
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        window.removeEventListener("resize", onWinResize);
        if (renderer) {
          try { renderer.dispose(); } catch (e) {}
          try { renderer.forceContextLoss(); } catch (e) {}
          renderer = null;
        }
        for (var i = 0; i < liveViewers.length; i++) {
          if (liveViewers[i] && liveViewers[i].dispose === dispose) {
            liveViewers.splice(i, 1);
            break;
          }
        }
        publishState();
      }

      loadThree().then(function (THREE) {
        if (disposed) return;
        var r;
        try {
          r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        } catch (e) {
          showFail("WebGL \u4e0d\u53ef\u7528\uff1a" + e.message + " \u2014 \u53ef\u70b9\u53f3\u4e0b\u89d2\u94fe\u63a5\u65b0\u6807\u7b7e\u9875\u6253\u5f00\u6a21\u578b\u6587\u4ef6");
          dispose();
          return;
        }
        renderer = r;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        host.insertBefore(renderer.domElement, host.firstChild);
        renderer.domElement.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
        group = new THREE.Group();
        scene.add(group);
        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        var key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(3, 5, 4);
        scene.add(key);
        var rim = new THREE.DirectionalLight(0x88aaff, 0.5);
        rim.position.set(-4, 2, -3);
        scene.add(rim);
        st.target = new THREE.Vector3();

        // 视口不可见 → 跳过渲染；滚回视野 → 补一帧
        if (typeof IntersectionObserver === "function") {
          io = new IntersectionObserver(function (entries) {
            var e0 = entries && entries[0];
            if (!e0) return;
            inView = e0.isIntersecting;
            if (inView) requestRender();
          }, { threshold: 0 });
          io.observe(host);
        }

        function fitToObject(obj) {
          var box = new THREE.Box3().setFromObject(obj);
          var center = box.getCenter(new THREE.Vector3());
          var size = box.getSize(new THREE.Vector3());
          var maxDim = Math.max(size.x, size.y, size.z) || 1;
          st.target.copy(center);
          st.radius = maxDim * 1.7;
          st.theta = 0.6;
          st.phi = 1.15;
          // ===== 2026-10-09 修复④：缩放范围改为**随模型尺寸自适应** =====
          // 旧版把滚轮缩放写死成 0.02 ~ 500，对真实项目模型（BIM/CAD 导出，
          // 尺寸动辄上万单位，如天加 UMA 机组 10022×2920×2511）就是灾难：
          // 一滚滚轮半径被砍到 500（模型瞬间贴脸），而且再也拉不回来。
          // 现在：最近 = 模型尺寸的 1%，最远 = 模型尺寸的 20 倍。
          st.minRadius = Math.max(maxDim * 0.01, 1e-5);
          st.maxRadius = Math.max(maxDim * 20, st.radius * 2);
          st.home = {
            target: center.clone(), radius: st.radius, theta: st.theta, phi: st.phi,
            minRadius: st.minRadius, maxRadius: st.maxRadius
          };
          // 近/远裁剪面同样跟尺寸走（近面比最小观察距离再近 10 倍，避免贴脸时被裁掉）
          camera.near = maxDim / 1000;
          camera.far = maxDim * 200;
          camera.updateProjectionMatrix();
          requestRender();
        }

        // pointer orbit / zoom / pan
        var lastX = 0, lastY = 0;
        var dom = renderer.domElement;
        dom.addEventListener("pointerdown", function (e) {
          dragging = e.button === 2 ? 2 : 1;
          lastX = e.clientX; lastY = e.clientY;
          try { dom.setPointerCapture(e.pointerId); } catch (_) {}
          host.style.cursor = "grabbing";
          e.preventDefault();
          requestRender();
        });
        dom.addEventListener("pointermove", function (e) {
          if (!dragging) return;
          var dx = e.clientX - lastX, dy = e.clientY - lastY;
          lastX = e.clientX; lastY = e.clientY;
          if (dragging === 1) {
            st.theta -= dx * 0.008;
            st.phi = Math.min(Math.PI - 0.05, Math.max(0.05, st.phi - dy * 0.008));
          } else {
            var scale = st.radius * 0.0016;
            var dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            var right = new THREE.Vector3().crossVectors(camera.up, dir).normalize();
            var up = new THREE.Vector3().crossVectors(dir, right).normalize();
            st.target.addScaledVector(right, dx * scale);
            st.target.addScaledVector(up, dy * scale);
          }
          requestRender();
        });
        function endDrag(e) {
          if (!dragging) return;
          dragging = 0;
          try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
          host.style.cursor = "grab";
          requestRender(); // 收尾帧
        }
        dom.addEventListener("pointerup", endDrag);
        dom.addEventListener("pointercancel", endDrag);
        dom.addEventListener("contextmenu", function (e) { e.preventDefault(); });
        dom.addEventListener("wheel", function (e) {
          e.preventDefault();
          // 2026-10-09 修复④：用自适应范围（见 fitToObject），不再写死 0.02~500
          var minR = st.minRadius || 0.02;
          var maxR = st.maxRadius || 500;
          st.radius = Math.min(maxR, Math.max(minR, st.radius * (e.deltaY < 0 ? 0.9 : 1.111)));
          publishState();
          requestRender();
        }, { passive: false });
        dom.addEventListener("dblclick", function () {
          if (st.home) {
            st.target.copy(st.home.target);
            st.radius = st.home.radius;
            st.theta = st.home.theta;
            st.phi = st.home.phi;
            st.minRadius = st.home.minRadius;
            st.maxRadius = st.home.maxRadius;
          }
          requestRender();
        });

        function doneLoading() {
          if (disposed) return;
          hint.style.display = "none";
          requestRender();
        }
        function failLoad(msg) {
          showFail("\u6a21\u578b\u52a0\u8f7d\u5931\u8d25\uff1a" + msg + " \u2014 \u53ef\u70b9\u53f3\u4e0b\u89d2\u94fe\u63a5\u65b0\u6807\u7b7e\u9875\u6253\u5f00");
          dispose();
        }

        var ext = EXT_RE.exec(src);
        var kind = ext ? ext[1].toLowerCase() : null;
        if (!kind) { showFail("\u672a\u77e5\u6a21\u578b\u683c\u5f0f"); dispose(); return; }

        var pipeline;
        if (kind === "gltf" || kind === "glb") {
          pipeline = loadExample("loaders/GLTFLoader.js").then(function (m) {
            var loader = new m.GLTFLoader();
            return fetch(src).then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.arrayBuffer().then(function (buf) {
                return new Promise(function (res, rej) {
                  loader.parse(buf, "", res, rej);
                });
              });
            }).then(function (gltf) {
              group.add(gltf.scene);
              fitToObject(gltf.scene);
            });
          });
        } else {
          var rel = kind === "obj" ? "loaders/OBJLoader.js" : "loaders/STLLoader.js";
          pipeline = loadExample(rel).then(function (m) {
            var Ctor = kind === "obj" ? m.OBJLoader : m.STLLoader;
            var loader = new Ctor();
            return fetch(src).then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.text().then(function (text) {
                var parsed = loader.parse(text);
                var obj = parsed;
                if (kind === "obj" && parsed.geometry) {
                  obj = new THREE.Mesh(parsed.geometry, new THREE.MeshStandardMaterial({
                    color: 0xd8e4ff, metalness: 0.15, roughness: 0.45, side: THREE.DoubleSide
                  }));
                } else if (kind === "obj") {
                  obj.traverse(function (c) {
                    if (c.isMesh) c.material = new THREE.MeshStandardMaterial({
                      color: 0xd8e4ff, metalness: 0.15, roughness: 0.45, side: THREE.DoubleSide
                    });
                  });
                } else {
                  obj.material = new THREE.MeshStandardMaterial({
                    color: 0xd8e4ff, metalness: 0.15, roughness: 0.45, side: THREE.DoubleSide
                  });
                }
                group.add(obj);
                fitToObject(obj);
              });
            });
          });
        }
        pipeline.then(doneLoading, failLoad);
      }).catch(function (e) {
        showFail("3D \u5f15\u64ce\u52a0\u8f7d\u5931\u8d25\uff08CDN \u4e0d\u53ef\u8fbe\uff09\uff1a" + e.message + " \u2014 \u53ef\u70b9\u53f3\u4e0b\u89d2\u94fe\u63a5\u65b0\u6807\u7b7e\u9875\u6253\u5f00");
        dispose();
      });

      liveViewers.push({ host: host, dispose: dispose, state: st });
      // 注意：不再往 disposables 里堆 host——那个数组只在插件卸载时清空，
      // 会把已被回收的查看器节点永久留引用（旧版内存只涨不降）。
      return host;
    }

    // --- inline detection ----------------------------------------------------
    // 2026-10-02 桌面端(0.2.0)适配：**非空代码块的语言不再出现在 DOM 里**。
    // 0.2.0 的 markdown 渲染器（dsh-client-ui-primitives renderCode）只在
    // 「空代码块」这一种情况下输出 <pre><code class="language-x">；非空代码块
    // 改走 CodeBlock 组件，DOM 变成：
    //   div.md-code-block > [div[data-code-block-banner] …] >
    //   div[data-code-block-content] > pre.shiki > code
    // 那个 <pre> 只带 class="shiki css-variables"，**没有任何语言类名/属性**；
    // banner 里的语言文字在「无法高亮的语言」（如 3d）上还会退化成通用「代码」
    // 文案。于是老判据 /language-3d/ 永远为假 → 代码块一直不被替换。
    // 新策略：有类名时（0.1.x 形态 / 空代码块）沿用老的多行扫描；没有类名时
    // 走「内容判定」——**整块恰好一行、且该行是绝对路径 + 3D 扩展名**才接管，
    // 这样普通代码块不会被误伤。
    var LANG_CLASS_RE = /(^|\s)(language-3d|lang-3d|code-3d)(\s|$)/;

    function codeLines(pre, code) {
      return ((code ? code.textContent : pre.textContent) || "")
        .split(/\r?\n/)
        .map(function (l) { return l.trim().replace(/^["']|["']$/g, ""); })
        .filter(function (l) { return l.length > 0; });
    }

    function isModelPath(line) {
      return EXT_RE.test(line) && MODEL_PATH_RE.test(line);
    }

    // 2026-10-02 第二轮修复：挂载方式从「replaceChild 换掉节点」改成
    // 「**隐藏原节点 + 在它后面插入视图**」。
    // 原因：那个 <pre> / <div.md-code-block> 是 **React 拥有的节点**，把它从
    // DOM 里摘掉后，React 下一次协调（消息还在流式更新/重渲染）会把代码块
    // 再放回来，看起来就像"插件没生效"。改成不动 React 的节点、只在它身上
    // 加一个自定义属性并配一条 !important 的隐藏规则，重渲染也顶不掉。
    var HIDE_ATTR = "data-dsv3d-hidden";
    var SKIP_ATTR = "data-dsv3d-skip";
    // 2026-10-08 真凶修复所需的护栏（见 mountViewer / processNode 注释）：
    var MAX_VIEWERS = 4;            // 同时存活的查看器上限（浏览器 WebGL 上下文约 16 个）
    var BREAKER_MAX = 40;           // 熔断阈值：短时间内挂载超过这个数就停手
    var BREAKER_WINDOW_MS = 8000;
    var mountTimes = [];
    var breakerTripped = false;

    // 自诊断出口：F12 控制台输入 __dsv3d 可看到插件当前的存活查看器数 / 挂载
    // 计数 / 熔断状态。正常状态应长期是 {live: 0~4, breakerTripped: false}。
    function publishState() {
      try {
        var last = null;
        for (var i = liveViewers.length - 1; i >= 0; i--) {
          if (liveViewers[i] && liveViewers[i].state) { last = liveViewers[i].state; break; }
        }
        window.__dsv3d = {
          live: liveViewers.length,
          mountsInWindow: mountTimes.length,
          breakerTripped: breakerTripped,
          maxViewers: MAX_VIEWERS,
          radius: last ? last.radius : null,
          minRadius: last ? last.minRadius : null,
          maxRadius: last ? last.maxRadius : null
        };
      } catch (e) { /* ignore */ }
    }

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin='dsh-plugin-3d-viewer']") !== null) return;
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin", "dsh-plugin-3d-viewer");
      tag.textContent = "[" + HIDE_ATTR + "]{display:none !important}";
      (document.head || document.documentElement).appendChild(tag);
    }

    function mountViewer(anchor, abs, src) {
      if (!anchor || !anchor.parentNode) return false;
      if (breakerTripped) return false;
      // 熔断器：正常使用绝不会在 8 秒内挂载 40 个查看器。真的失控了，
      // 宁可不出图也不能把整个界面拖死（这是 2026-10-08 那次事故的兜底）。
      var now = Date.now();
      mountTimes.push(now);
      while (mountTimes.length > 0 && now - mountTimes[0] > BREAKER_WINDOW_MS) mountTimes.shift();
      if (mountTimes.length > BREAKER_MAX) {
        breakerTripped = true;
        try {
          console.warn("[3d-viewer] 熔断：短时间内挂载次数异常，已停止自动挂载（界面不受影响，刷新页面可恢复）");
        } catch (e) { /* ignore */ }
        return false;
      }
      // 上限：超出就回收最旧的查看器（连带移除它的画布节点）
      while (liveViewers.length >= MAX_VIEWERS) {
        var old = liveViewers.shift();
        try { if (old && old.dispose) old.dispose(); } catch (e) { /* ignore */ }
        try { if (old && old.host && old.host.parentNode) old.host.parentNode.removeChild(old.host); } catch (e) { /* ignore */ }
      }
      anchor.setAttribute("data-dsv3d", "1");
      anchor.setAttribute(HIDE_ATTR, "1");
      anchor.parentNode.insertBefore(makeViewerHost(src, abs), anchor.nextSibling);
      publishState();
      try { console.info("[3d-viewer] 已挂载 3D 视图:", abs); } catch (e) { /* console 不可用就算了 */ }
      return true;
    }

    function extractPathFromPre(pre) {
      if (pre.getAttribute("data-dsv3d") !== null) return null;
      var owner = closestCodeCard(pre);
      if (owner !== null && owner.getAttribute("data-dsv3d") !== null) return null;
      var code = pre.querySelector("code");
      if (!code) return null;
      var hasLangClass = LANG_CLASS_RE.test(code.className || "");
      var lines = codeLines(pre, code);
      if (hasLangClass) {
        for (var i = 0; i < lines.length; i++) if (isModelPath(lines[i])) return lines[i];
        return null;
      }
      // 0.2.0 形态：只在「整块一行、且就是 3D 模型绝对路径」时接管
      if (lines.length === 1 && isModelPath(lines[0])) return lines[0];
      return null;
    }

    // 0.2.0 把代码块包在 div.md-code-block 里；只隐藏 <pre> 会留下 banner
    // （语言标签 + 复制按钮）的空壳，所以隐藏整张卡片。
    function closestCodeCard(pre) {
      var el = pre.parentNode;
      for (var i = 0; i < 4 && el && el.nodeType === 1; i++) {
        if (el.classList && el.classList.contains("md-code-block")) return el;
        el = el.parentNode;
      }
      return null;
    }

    function processNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.getAttribute && node.getAttribute("data-dsv3d") !== null) return false;
      if (node.getAttribute && node.getAttribute(SKIP_ATTR) !== null) return false;
      // ===== 2026-10-08 真凶修复（本次卡死的真正原因）=====
      // 查看器自己的「新标签页打开」链接 href 也是 /model3d/...，会被扫描器当成
      // 新的 3D 触发点 → 又挂一个查看器 → 又生成一个 /model3d 链接 → 再挂……
      // 全程跑在 MutationObserver 的微任务里，主线程永远回不到事件循环。
      // 实测：**一个触发点 21 毫秒内堆出 399 个查看器 / 199 个 WebGL 上下文**，
      // 随后整页无响应（连 F12 都打不开）——正是用户报的「DSH 无响应」。
      // 规则：任何处在"已挂载查看器内部"的节点一律不处理。
      if (node.closest && node.closest("[data-dsv3d]") !== null) return false;
      var tag = node.tagName;
      if (tag === "PRE") {
        var abs = extractPathFromPre(node);
        if (!abs) return false;
        recordModel(abs); // 2026-10-09：登记到右侧栏面板的模型清单（不管是否挂上查看器）
        var card = closestCodeCard(node);
        return mountViewer(card !== null ? card : node, abs, modelUrl(abs));
      }
      if (tag === "A") {
        var href = node.getAttribute("href") || "";
        if (href.indexOf("/model3d/") !== 0) return false;
        if (node.getAttribute("data-dsv3d") !== null) return false;
        var absPath = node.textContent.trim();
        if (!absPath) {
          try { absPath = decodeURIComponent(href.slice("/model3d/".length)); } catch (_) { absPath = href; }
        }
        recordModel(absPath); // 同上
        return mountViewer(node, absPath, href);
      }
      return false;
    }

    function scan(root) {
      if (!root || !root.querySelectorAll) return;
      if (breakerTripped) return;
      // 查看器内部不扫描（同上：防止自己的 /model3d 链接触发套娃）
      if (root.closest && root.closest("[data-dsv3d]") !== null) return;
      var pres = root.querySelectorAll("pre");
      for (var i = 0; i < pres.length; i++) processNode(pres[i]);
      var anchors = root.querySelectorAll('a[href^="/model3d/"]');
      for (var j = 0; j < anchors.length; j++) processNode(anchors[j]);
    }

    // ===== 2026-10-09 新增：右侧栏「3D 模型」常驻预览面板 =====
    // 用户需求（原话）：「增加一个功能，我想可以在侧边栏上查看」→ 选定方案：右侧面板常驻
    // 一个 3D 预览窗，列出的模型 = **当前会话里出现过的**。
    // 机制：用官方公开 API `ctx.sidebarRightTabs.register()` 注册一个右侧栏标签页类型，
    //       再用 `ctx.sidebarRight.openTab(kind)` 打开（它会顺带展开右侧栏）。
    //       面板内容 = 本会话见过的模型清单 + 内嵌查看器（复用 makeViewerHost）。
    // 注意：全部包在 try/catch 里——右侧栏服务不存在时静默跳过，聊天内联查看不受影响。
    var PANEL_ID = "dsh-plugin-3d-viewer:panel";
    var PANEL_KIND = "dsh-plugin-3d-viewer";
    var panelApi = null;            // ctx.sidebarRight
    var panelSession = "unknown";   // 屏幕上正在看的会话（模型按它归类）
    var panelState = { seen: [], selected: null, listeners: [], version: 0 };

    function panelEmit() {
      panelState.version++;
      for (var i = 0; i < panelState.listeners.length; i++) {
        try { panelState.listeners[i](); } catch (e) { /* ignore */ }
      }
      try {
        window.__dsv3dPanel = {
          version: panelState.version,
          selected: panelState.selected,
          session: panelSession,
          entries: panelState.seen.map(function (e) {
            return { path: e.path, url: e.url, sessionId: e.sessionId };
          })
        };
      } catch (e2) { /* ignore */ }
    }

    // 扫描器只要在一段 3D 代码块/链接里认出模型路径，就登记进来（不管挂没挂上查看器）
    function recordModel(absPath) {
      if (!absPath) return;
      var url = modelUrl(absPath);
      for (var i = 0; i < panelState.seen.length; i++) {
        if (panelState.seen[i].url === url) return;
      }
      panelState.seen.push({ path: absPath, url: url, sessionId: panelSession, t: Date.now() });
      panelEmit();
    }

    function panelEntriesFor(sessionId) {
      return panelState.seen.filter(function (e) {
        return e.sessionId === sessionId || e.sessionId === "unknown";
      });
    }

    function basenameOf(absPath) {
      var s = String(absPath).replace(/\\/g, "/");
      var i = s.lastIndexOf("/");
      return i >= 0 ? s.slice(i + 1) : s;
    }

    // 安全取服务：cordis 里访问**未声明注入**的服务会直接抛错（历史上"插件整体激活失败"
    // 就是这个坑）。这里优先走 ctx.reflect.get(name, false)（找不到返回 undefined，不抛），
    // 再退回 ctx[name]（用 try 兜住）。取不到就当作没有这个能力，面板静默跳过。
    function getService(ctx, name) {
      try {
        if (ctx && ctx.reflect && typeof ctx.reflect.get === "function") {
          var v = ctx.reflect.get(name, false);
          if (v) return v;
        }
      } catch (e) { /* ignore */ }
      try { return ctx[name] || null; } catch (e2) { return null; }
    }

    // 打开右侧栏并在面板里选中这个模型
    function openInPanel(absPath, url) {
      panelState.selected = url || (absPath ? modelUrl(absPath) : null);
      panelEmit();
      try {
        if (panelApi && typeof panelApi.openTab === "function") {
          panelApi.openTab(PANEL_KIND, { revealIfOpened: true });
        }
      } catch (e) {
        try { console.warn("[3d-viewer] 打开右侧栏失败：", e); } catch (e2) { /* ignore */ }
      }
    }

    var PANEL_STYLE = {
      wrap: "display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:10px;" +
        "box-sizing:border-box;font-family:system-ui,'Microsoft YaHei',sans-serif;",
      head: "font-size:12px;opacity:.72;flex:0 0 auto;",
      listWrap: "flex:0 0 auto;max-height:34%;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;",
      listEmpty: "font-size:12px;opacity:.6;line-height:1.6;",
      btn: "cursor:pointer;font-size:12px;padding:3px 8px;border-radius:6px;" +
        "border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;max-width:100%;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      btnActive: "cursor:pointer;font-size:12px;padding:3px 8px;border-radius:6px;" +
        "border:1px solid rgba(80,160,255,.9);background:rgba(80,160,255,.18);color:inherit;max-width:100%;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      previewWrap: "flex:1 1 auto;min-height:220px;border-radius:12px;overflow:hidden;" +
        "border:1px solid rgba(127,127,127,.25);",
      previewInner: "width:100%;height:100%;",
      foot: "flex:0 0 auto;font-size:11px;opacity:.5;"
    };

    // 面板 UI。React 由 DSH 客户端模块系统提供（require("react")）。
    // **刻意不用 hooks**：不同 DSH 版本的 React 实例/版本可能不同，hooks 只要与渲染器
    // 不是同一实例就会抛 React error #62（实测踩到）。这里只用 createElement + 回调 ref，
    // 内容全部用原生 DOM 生成，任何 React 版本都稳。
    function buildPanelComponents(React) {
      var h = React.createElement;

      function PanelTitle() {
        return h("span", null, "3D \u6a21\u578b");
      }

      function PanelBody(props) {
        var sessionId = (props && props.sessionId) || panelSession || "unknown";
        var holder = { node: null };
        return h("div", {
          ref: function (node) {
            if (node) {
              holder.node = node;
              try { mountPanelDom(node, sessionId); } catch (e) {
                try { window.__dsv3dPanelError = "mountPanelDom: " + String(e); } catch (e2) { /* ignore */ }
              }
            } else if (holder.node && holder.node.__dsv3dCleanup) {
              try { holder.node.__dsv3dCleanup(); } catch (e3) { /* ignore */ }
              holder.node = null;
            }
          }
        });
      }

      return { PanelTitle: PanelTitle, PanelBody: PanelBody };
    }

    // 用原生 DOM 搭出面板内容（模型清单 + 预览区），并订阅注册表变化自动刷新。
    function mountPanelDom(el, sessionId) {
      // 幂等：React（StrictMode / 重渲染 / 多容器）可能对同一节点重复调用 ref 回调，
      // 先把上一次的内容与订阅清干净再重建，避免面板里出现多份重复界面。
      if (el.__dsv3dCleanup) {
        try { el.__dsv3dCleanup(); } catch (e0) { /* ignore */ }
        el.__dsv3dCleanup = null;
      }
      el.textContent = "";
      el.setAttribute("data-dsv3d-panel", "1");
      el.style.cssText = PANEL_STYLE.wrap;

      var head = document.createElement("div");
      head.style.cssText = PANEL_STYLE.head;
      el.appendChild(head);

      var listWrap = document.createElement("div");
      listWrap.style.cssText = PANEL_STYLE.listWrap;
      el.appendChild(listWrap);

      var previewWrap = document.createElement("div");
      previewWrap.style.cssText = PANEL_STYLE.previewWrap;
      var previewInner = document.createElement("div");
      previewInner.style.cssText = PANEL_STYLE.previewInner;
      previewWrap.appendChild(previewInner);
      el.appendChild(previewWrap);

      var foot = document.createElement("div");
      foot.style.cssText = PANEL_STYLE.foot;
      foot.textContent = "\u5de6\u952e\u62d6\u52a8\u65cb\u8f6c \u00b7 \u6eda\u8f6e\u7f29\u653e \u00b7 \u53cc\u51fb\u590d\u4f4d";
      el.appendChild(foot);

      var shownViewer = null; // 当前预览里挂着的查看器 host

      function currentEntry(entries) {
        var cur = panelState.selected;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].url === cur) return entries[i];
        }
        return entries.length > 0 ? entries[0] : null;
      }

      function renderList(entries, cur) {
        listWrap.textContent = "";
        head.textContent = "\u672c\u4f1a\u8bdd\u7684 3D \u6a21\u578b\uff08" + entries.length + "\uff09";
        if (entries.length === 0) {
          var empty = document.createElement("div");
          empty.style.cssText = PANEL_STYLE.listEmpty;
          empty.textContent = "\u672c\u4f1a\u8bdd\u8fd8\u6ca1\u6709\u51fa\u73b0\u8fc7 3D \u6a21\u578b\u3002\u5728\u5bf9\u8bdd\u91cc\u8ba9\u52a9\u624b\u53d1\u4e00\u4e2a\u6a21\u578b\uff0c\u6216\u6253\u5f00\u542b\u6a21\u578b\u7684\u5386\u53f2\u6d88\u606f\u5373\u53ef\u3002";
          listWrap.appendChild(empty);
          return;
        }
        entries.forEach(function (e) {
          var b = document.createElement("button");
          b.type = "button";
          b.title = e.path;
          b.setAttribute("data-dsv3d-model", basenameOf(e.path));
          b.textContent = basenameOf(e.path);
          b.style.cssText = (cur && e.url === cur.url) ? PANEL_STYLE.btnActive : PANEL_STYLE.btn;
          b.addEventListener("click", function () {
            panelState.selected = e.url;
            panelEmit();
          });
          listWrap.appendChild(b);
        });
      }

      function renderPreview(entry) {
        if (shownViewer && shownViewer.parentNode) {
          try { shownViewer.parentNode.removeChild(shownViewer); } catch (e1) { /* ignore */ }
        }
        shownViewer = null;
        try { previewInner.textContent = ""; } catch (e1b) { /* ignore */ }
        if (!entry) return;
        try {
          shownViewer = makeViewerHost(entry.url, entry.path, { fill: true, inPanel: true });
          previewInner.appendChild(shownViewer);
          shownViewer.setAttribute("data-dsv3d-for", entry.url);
        } catch (e2) { /* ignore */ }
      }

      function refresh() {
        var entries = panelEntriesFor(sessionId);
        var cur = currentEntry(entries);
        renderList(entries, cur);
        var curUrl = cur ? cur.url : null;
        var mountedUrl = shownViewer ? shownViewer.getAttribute("data-dsv3d-for") : null;
        if (curUrl !== mountedUrl) renderPreview(cur);
      }

      panelState.listeners.push(refresh);
      refresh();

      el.__dsv3dCleanup = function () {
        var i = panelState.listeners.indexOf(refresh);
        if (i >= 0) panelState.listeners.splice(i, 1);
        if (shownViewer && shownViewer.parentNode) {
          try { shownViewer.parentNode.removeChild(shownViewer); } catch (e4) { /* ignore */ }
        }
        shownViewer = null;
        try { previewInner.textContent = ""; } catch (e5) { /* ignore */ }
      };
    }

    // 注册右侧栏「3D 模型」面板。**只在 ctx.inject 回调里调用**——那时
    // ctx.sidebarRightTabs / ctx.sidebarRight / ctx.slots 都已确认注入可用。
    function registerPanel(pctx) {
      var tabs = pctx.sidebarRightTabs;
      var right = pctx.sidebarRight;
      var slots = pctx.slots;
      var React = null;
      try { React = require("react"); } catch (e) { React = null; }
      if (!React || typeof React.createElement !== "function") {
        try { console.warn("[3d-viewer] 取不到 react，跳过「3D 模型」面板"); } catch (e1) { /* ignore */ }
        return null;
      }
      panelApi = right;
      var comps = buildPanelComponents(React);
      var disposeType = tabs.register({
        id: PANEL_ID,
        kind: PANEL_KIND,
        multiple: false,
        keepMounted: true,
        title: function () { return "3D \u6a21\u578b"; },
        guide: [{
          id: "3d-viewer",
          order: 40,
          title: function () { return "3D \u6a21\u578b\u9884\u89c8"; },
          description: function () { return "\u67e5\u770b\u5f53\u524d\u4f1a\u8bdd\u91cc\u51fa\u73b0\u8fc7\u7684 3D \u6a21\u578b"; }
        }]
      });
      var disposeBody = slots.inject("sidebar.right.pane.tab", function () {
        return slots.register({
          name: "sidebar.right.pane.tab",
          key: PANEL_ID,
          inject: function (sessionId) { return { sessionId: sessionId }; }
        }, comps.PanelBody);
      });
      var disposeTitle = slots.inject("sidebar.right.pane.tab.title", function () {
        return slots.register({
          name: "sidebar.right.pane.tab.title",
          key: PANEL_ID
        }, comps.PanelTitle);
      });
      // 跟踪「屏幕上正在看的会话」，让模型按会话归类
      var unsubscribe = null;
      try {
        var mounted = right.mounted;
        var sync = function () {
          try {
            var v = mounted && typeof mounted.getSnapshot === "function" ? mounted.getSnapshot() : null;
            if (v) panelSession = v;
          } catch (e2) { /* ignore */ }
        };
        sync();
        if (mounted && typeof mounted.subscribe === "function") unsubscribe = mounted.subscribe(sync);
      } catch (e3) { /* ignore */ }
      try {
        window.__dsv3dPanelDiag = {
          registered: !!disposeType, body: !!disposeBody, title: !!disposeTitle,
          expanded: (function () { try { return right.isExpanded(); } catch (e) { return "err"; } })(),
          openTabType: typeof right.openTab,
          react: {
            version: React.version || null,
            keys: (function () { try { return Object.keys(React).slice(0, 24).join(","); } catch (e) { return "err"; } })(),
            useState: typeof React.useState,
            useEffect: typeof React.useEffect,
            useRef: typeof React.useRef,
            createElement: typeof React.createElement,
            hasDefault: !!React.default
          }
        };
      } catch (e4) { /* ignore */ }
      try { console.info("[3d-viewer] 右侧栏「3D 模型」面板已注册（kind=" + PANEL_KIND + "）"); } catch (e5) { /* ignore */ }
      // 卸载时回收
      pctx.effect(function () {
        return function () {
          if (typeof unsubscribe === "function") { try { unsubscribe(); } catch (e6) { /* ignore */ } }
          try { disposeTitle(); } catch (e7) { /* ignore */ }
          try { disposeBody(); } catch (e8) { /* ignore */ }
          try { disposeType(); } catch (e9) { /* ignore */ }
          panelApi = null;
        };
      }, "3d-viewer: 右侧栏面板回收");
      return disposeType;
    }

    function apply(ctx) {
      ensureStyle();
      // ===== 2026-10-09 新增：右侧栏「3D 模型」面板注册 =====
      // 关键（踩过一次坑）：cordis 里**未在 inject 里声明的服务取不到**（反射/ctx.get 都
      // 拿不到，直接访问更会抛错）。但把 sidebarRight / sidebarRightTabs 写进 package.json
      // 的 dsh.client.inject 是"必需"语义 —— 宿主没有这两个服务（例如版本差异）就会
      // **整个插件激活失败**（实测过：页面报 "1 entry did not activate"）。
      // 所以改用 **局部依赖 `ctx.inject([...], cb)`**：依赖齐了才执行注册，缺一个就只是
      // 少一块面板，聊天里的内联 3D 查看永远不受影响。
      try {
        ctx.inject(["slots", "sidebarRightTabs", "sidebarRight"], function (scoped) {
          try {
            registerPanel(scoped);
          } catch (err) {
            try { console.warn("[3d-viewer] 注册右侧栏面板失败（不影响内联查看）：", err); } catch (e2) { /* ignore */ }
          }
        });
      } catch (eInject) {
        try { console.warn("[3d-viewer] ctx.inject 不可用，跳过「3D 模型」面板：", eInject); } catch (e3) { /* ignore */ }
      }
      // （注册逻辑在 registerPanel 里，只有上面 ctx.inject 的回调被触发时才执行）
      ctx.effect(
        function () {
          var timer = null;
          var obs = new MutationObserver(function (muts) {
            // 每次回调最多处理 6 个新挂载点：即使出现意料之外的插入形态，
            // 也不可能在一次微任务里滚成雪崩（正常的聊天渲染远低于这个数）。
            var budget = 6;
            for (var i = 0; i < muts.length && budget > 0; i++) {
              var m = muts[i];
              if (m.type !== "childList") continue;
              for (var k = 0; k < m.addedNodes.length && budget > 0; k++) {
                var n = m.addedNodes[k];
                if (n.nodeType !== 1) continue;
                if (n.tagName === "PRE" || n.tagName === "A") { if (processNode(n)) budget--; }
                else if (n.querySelectorAll) { scan(n); budget--; }
              }
            }
          });
          function start() {
            if (!document.body) return;
            scan(document.body);
            obs.observe(document.body, { childList: true, subtree: true });
            // 自愈保险：MutationObserver 有可能漏掉某些形态的插入（React 先
            // 建容器后填子节点、或是把代码块"放回来"），每 2 秒复查一次。
            // 扫描是幂等的——已挂载的节点带 data-dsv3d，直接跳过。
            timer = window.setInterval(function () {
              try { scan(document.body); } catch (e) { /* ignore */ }
              // 回收 host 已脱离 DOM 的 viewer（React 重挂载留下的孤儿；旧版泄漏永久累积）
              for (var i = liveViewers.length - 1; i >= 0; i--) {
                var v = liveViewers[i];
                if (v && v.host && !document.contains(v.host)) {
                  try { v.dispose(); } catch (e2) { /* ignore */ }
                }
              }
              publishState();
            }, 2000);
            try { console.info("[3d-viewer] 观察器已挂上（等待 3d 代码块）"); } catch (e) { /* ignore */ }
          }
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", start, { once: true });
          } else {
            start();
          }
          return function () {
            obs.disconnect();
            if (timer !== null) { window.clearInterval(timer); timer = null; }
            for (var i = liveViewers.length - 1; i >= 0; i--) {
              try { liveViewers[i].dispose(); } catch (e) { /* ignore */ }
              try {
                var h = liveViewers[i] && liveViewers[i].host;
                if (h && h.parentNode) h.parentNode.removeChild(h);
              } catch (e2) { /* ignore */ }
            }
            liveViewers.length = 0;
            disposables.length = 0;
            // 卸载时把隐藏过的原节点恢复出来
            var hidden = document.querySelectorAll("[" + HIDE_ATTR + "]");
            for (var h2 = 0; h2 < hidden.length; h2++) hidden[h2].removeAttribute(HIDE_ATTR);
          };
        },
        "3d-viewer: inline 3d code blocks & /model3d links"
      );
    }

    exports.apply = apply;
    // 声明必需服务：slots（右侧栏面板要用）。**不要**把 sidebarRight / sidebarRightTabs
    // 写进这里——dsh.client.inject 只有"必需"语义，声明了而宿主没有会让整个插件激活失败；
    // 这两个服务改用 getService() 反射获取，取不到就只是少一个面板。
    exports.inject = ["slots"];
    return module.exports;
  }
});
