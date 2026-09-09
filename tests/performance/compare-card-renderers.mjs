// Bounded compositor prototype, not a replacement UI or physical-phone benchmark.
// Shared DOM grid/action targets; CSS DOM text versus Canvas/WebGL raster text.
import { chromium, webkit } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const output = process.argv[2] || "data/card-renderers";
await mkdir(output, { recursive: true });
const results = [];
for (const [engine, driver] of Object.entries({ chromium, webkit })) {
  const browser = await driver.launch();
  for (const mode of ["css", "canvas2d", "webgl"]) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    let layers = null,
      session;
    if (engine === "chromium") {
      session = await page.context().newCDPSession(page);
      await session.send("LayerTree.enable");
      session.on("LayerTree.layerTreeDidChange", (event) => {
        layers = event.layers?.filter((l) => l.drawsContent).length ?? null;
      });
    }
    await page.setContent(
      `<style>*{box-sizing:border-box}body{margin:0;background:#eef0e7;font:14px Arial}#grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;padding:16px}#grid img{width:100%;aspect-ratio:488/680}#surface{position:fixed;inset:0;pointer-events:none}#active{position:absolute;left:530px;top:207px;width:220px;height:306.56px;transform-origin:center}#active img{width:100%;height:100%}#meta{position:absolute;bottom:0;left:0;right:0;padding:12px;background:#13251de8;color:white;font:14px Arial}#meta strong{display:block;font-size:16px}canvas{position:fixed;inset:0}#wheel button{position:fixed;width:126px;min-height:48px;transform:translate(-50%,-50%);background:#304d3c;color:white;border:1px solid #aec1ab;border-radius:9px;white-space:normal}#caption{position:fixed;left:16px;top:8px;background:white;padding:8px;z-index:4}</style><div id=grid></div><div id=surface><div id=active><img><div id=meta><strong>Ancient Silver Dragon</strong>CLB #56 · EN<br>1 owned · nonfoil<br>Double Dragon × 2</div></div></div><div id=wheel></div><div id=caption>${engine} · ${mode} · controlled prototype</div>`,
    );
    const report = await page.evaluate(async (mode) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><defs><linearGradient id="g"><stop stop-color="#274853"/><stop offset="1" stop-color="#80949a"/></linearGradient></defs><rect width="488" height="680" rx="24" fill="#13251d"/><rect x="20" y="20" width="448" height="408" rx="15" fill="url(#g)"/><path d="M70 320L210 80l55 150 150-80-80 180-90-35-60 75z" fill="#c5d0d1"/><text x="34" y="472" fill="white" font-family="Arial" font-size="28">Ancient Silver Dragon</text><path d="M34 510h420M34 535h395M34 560h400M34 585h330" stroke="#d8dfd8" stroke-width="9"/></svg>`;
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(svg);
      await img.decode();
      const grid = document.querySelector("#grid");
      for (let i = 0; i < 1000; i++) {
        const copy = img.cloneNode();
        copy.loading = "lazy";
        grid.append(copy);
      }
      const active = document.querySelector("#active");
      active.querySelector("img").src = img.src;
      const labels = [
        "Card details",
        "Review & add",
        "Double Dragon",
        "A long readable deck label",
        "Draft Box",
        "More tags…",
      ];
      labels.forEach((label, i) => {
        const b = document.createElement("button"),
          a = -Math.PI / 2 + (i * Math.PI) / 3;
        b.textContent = label;
        b.style.left = 640 + Math.cos(a) * 290 + "px";
        b.style.top = 360 + Math.sin(a) * 270 + "px";
        document.querySelector("#wheel").append(b);
      });
      const texture = document.createElement("canvas");
      texture.width = 488;
      texture.height = 680;
      const tc = texture.getContext("2d");
      tc.drawImage(img, 0, 0);
      tc.fillStyle = "#13251de8";
      const factor = 488 / 220,
        meta = document.querySelector("#meta"),
        top = meta.offsetTop * factor;
      tc.fillRect(0, top, 488, meta.offsetHeight * factor);
      tc.fillStyle = "white";
      tc.font = "bold 35.49px Arial";
      tc.fillText("Ancient Silver Dragon", 12 * factor, top + 27 * factor);
      tc.font = "31.05px Arial";
      ["CLB #56 · EN", "1 owned · nonfoil", "Double Dragon × 2"].forEach(
        (t, i) => tc.fillText(t, 12 * factor, top + (44 + i * 16) * factor),
      );
      let canvas,
        ctx,
        gl,
        program,
        position,
        uv,
        gpu = null;
      if (mode !== "css") {
        active.hidden = true;
        canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        document.querySelector("#surface").append(canvas);
        if (mode === "canvas2d") ctx = canvas.getContext("2d");
        else {
          gl = canvas.getContext("webgl", {
            alpha: true,
            premultipliedAlpha: false,
          });
          if (!gl) return { unsupported: "WebGL unavailable" };
          const extension = gl.getExtension("WEBGL_debug_renderer_info");
          gpu = extension
            ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
            : "Unavailable";
          const shader = (type, source) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, source);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
              throw Error(gl.getShaderInfoLog(s));
            return s;
          };
          program = gl.createProgram();
          gl.attachShader(
            program,
            shader(
              gl.VERTEX_SHADER,
              "attribute vec4 p;attribute vec2 uv;varying vec2 v;void main(){gl_Position=p;v=uv;}",
            ),
          );
          gl.attachShader(
            program,
            shader(
              gl.FRAGMENT_SHADER,
              "precision mediump float;varying vec2 v;uniform sampler2D tex;uniform float opacity;void main(){gl_FragColor=texture2D(tex,v)*vec4(1.,1.,1.,opacity);}",
            ),
          );
          gl.linkProgram(program);
          gl.useProgram(program);
          position = gl.createBuffer();
          uv = gl.createBuffer();
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            texture,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindBuffer(gl.ARRAY_BUFFER, uv);
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
            gl.STATIC_DRAW,
          );
          const attr = gl.getAttribLocation(program, "uv");
          gl.enableVertexAttribArray(attr);
          gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
        }
      }
      let latest = { x: 640, y: 360, time: performance.now() },
        index = 0;
      document.addEventListener("pointermove", (e) => {
        latest = { x: e.clientX, y: e.clientY, time: performance.now() };
      });
      const input = setInterval(() => {
        index++;
        document.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: 640 + 170 * Math.sin(index * 0.07),
            clientY: 360 + 130 * Math.cos(index * 0.05),
          }),
        );
      }, 16);
      const intervals = [],
        latencies = [],
        work = [];
      let last;
      function render(i) {
        const rx = ((latest.y - 360) / 130) * 7,
          ry = ((latest.x - 640) / 170) * 7,
          scale = i < 80 ? 2 : i < 160 ? 3 : 2,
          drag = i >= 160,
          dx = drag ? latest.x - 640 : 0,
          dy = drag ? latest.y - 360 : 0,
          opacity = drag ? 0.25 : 1;
        if (mode === "css") {
          active.style.transform = `translate(${dx}px,${dy}px) perspective(1100px) rotateX(${rx}deg) rotateY(${ry}deg) scale(${scale})`;
          active.style.opacity = opacity;
          return;
        }
        const ax = (rx * Math.PI) / 180,
          ay = (ry * Math.PI) / 180;
        const project = (u, v) => {
          let x = (u - 0.5) * 220 * scale,
            y = (v - 0.5) * 306.56 * scale,
            z = -x * Math.sin(ay);
          x *= Math.cos(ay);
          const yy = y * Math.cos(ax) - z * Math.sin(ax);
          z = y * Math.sin(ax) + z * Math.cos(ax);
          const w = 1 - z / 1100;
          return { x: 640 + dx + x / w, y: 360 + dy + yy / w, w };
        };
        if (gl) {
          gl.clear(gl.COLOR_BUFFER_BIT);
          const coords = [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 0],
            [1, 1],
            [0, 1],
          ].flatMap(([u, v]) => {
            const p = project(u, v);
            return [(p.x / 640 - 1) * p.w, (1 - p.y / 360) * p.w, 0, p.w];
          });
          gl.bindBuffer(gl.ARRAY_BUFFER, position);
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array(coords),
            gl.DYNAMIC_DRAW,
          );
          const attr = gl.getAttribLocation(program, "p");
          gl.enableVertexAttribArray(attr);
          gl.vertexAttribPointer(attr, 4, gl.FLOAT, false, 0, 0);
          gl.uniform1f(gl.getUniformLocation(program, "opacity"), opacity);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          return;
        }
        ctx.clearRect(0, 0, 1280, 720);
        ctx.globalAlpha = opacity;
        // Affine mesh approximates the same perspective projection in Canvas 2D.
        const triangle = (a, b, c) => {
          const pa = project(...a),
            pb = project(...b),
            pc = project(...c),
            x0 = a[0] * 488,
            y0 = a[1] * 680,
            x1 = b[0] * 488,
            y1 = b[1] * 680,
            x2 = c[0] * 488,
            y2 = c[1] * 680,
            den = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
          const coeff = (v0, v1, v2) => [
            (v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1)) / den,
            (v0 * (x2 - x1) + v1 * (x0 - x2) + v2 * (x1 - x0)) / den,
            (v0 * (x1 * y2 - x2 * y1) +
              v1 * (x2 * y0 - x0 * y2) +
              v2 * (x0 * y1 - x1 * y0)) /
              den,
          ];
          const x = coeff(pa.x, pb.x, pc.x),
            y = coeff(pa.y, pb.y, pc.y);
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.lineTo(pc.x, pc.y);
          ctx.closePath();
          ctx.clip();
          ctx.setTransform(x[0], y[0], x[1], y[1], x[2], y[2]);
          ctx.drawImage(texture, 0, 0);
          ctx.restore();
        };
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const a = [x / 8, y / 8],
              b = [(x + 1) / 8, y / 8],
              c = [x / 8, (y + 1) / 8],
              d = [(x + 1) / 8, (y + 1) / 8];
            triangle(a, b, c);
            triangle(b, d, c);
          }
      }
      await new Promise((resolve) => {
        let i = 0;
        function frame(t) {
          if (last && i > 10) intervals.push(t - last);
          last = t;
          latencies.push(performance.now() - latest.time);
          const begin = performance.now();
          render(i);
          work.push(performance.now() - begin);
          if (++i < 240) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });
      clearInterval(input);
      latest = { x: 740, y: 280, time: performance.now() };
      render(70);
      const stats = (values) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return {
          p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(3),
          p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3),
        };
      };
      return {
        frames: 240,
        frameMs: stats(intervals),
        missed60HzSlots: intervals.reduce(
          (n, ms) => n + Math.max(0, Math.round(ms / (1000 / 60)) - 1),
          0,
        ),
        syntheticInputToRafMs: stats(latencies),
        jsSubmitMs: stats(work),
        gpu,
        text: mode === "css" ? "DOM text" : "488×680 raster text",
        backgroundCards: 1000,
        physicalDevice: false,
      };
    }, mode);
    await page.screenshot({ path: `${output}/${engine}-${mode}.png` });
    results.push({ engine, mode, ...report, chromiumDrawingLayers: layers });
    await session?.detach();
    await page.close();
  }
  await browser.close();
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
