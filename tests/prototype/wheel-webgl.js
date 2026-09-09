import { createWheelSectors } from "/card-wheel-view.js";

// Local comparative renderer: one reusable context, no autonomous render loop.
// It shades a convex glass surface; it does not sample/refract the DOM behind it.
let runtime = null;
let activeSurface = null;
const vertexSource = `attribute vec2 position;
varying vec2 uv;
void main(){ uv=position; gl_Position=vec4(position,0.0,1.0); }`;
const fragmentSource = `precision highp float;
varying vec2 uv;
uniform float innerRadius;
uniform float sectorCount;
uniform float strengths[10];
uniform vec2 lightPoint;
uniform float pixelSize;
const float PI=3.14159265359;
const float TAU=6.28318530718;
void main(){
  vec2 p=vec2(uv.x,-uv.y);
  float r=length(p);
  float angle=mod(atan(p.y,p.x)+PI*.5+PI/sectorCount+TAU,TAU);
  float sector=floor(angle/TAU*sectorCount);
  float local=fract(angle/TAU*sectorCount);
  float band=clamp((r-innerRadius)/(1.0-innerRadius),0.0,1.0);
  float radialMask=smoothstep(innerRadius-pixelSize,innerRadius+pixelSize,r)*(1.0-smoothstep(1.0-pixelSize*3.0,1.0,r));
  float angularMask=smoothstep(0.001,0.004,local)*(1.0-smoothstep(.996,.999,local));
  if(radialMask*angularMask<.001) discard;
  float strength=0.0;
  for(int i=0;i<10;i++){ if(abs(float(i)-sector)<.5) strength=strengths[i]; }
  float bulge=sin(PI*band)*sin(PI*local);
  vec2 radial=p/max(r,.001);
  vec2 tangent=vec2(-radial.y,radial.x);
  float dr=cos(PI*band)*sin(PI*local)*.72;
  float dt=sin(PI*band)*cos(PI*local)*.4;
  vec3 normal=normalize(vec3(-radial*dr-tangent*dt,1.0));
  vec3 light=normalize(vec3(lightPoint-p,1.35));
  float diffuse=max(dot(normal,light),0.0);
  float highlight=pow(max(dot(normal,normalize(light+vec3(0.,0.,1.))),0.0),52.0);
  float rim=pow(1.0-normal.z,2.0);
  float fineNoise=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)*.012;
  vec3 tint=mix(vec3(.045,.13,.10),vec3(.14,.29,.22),diffuse);
  tint+=vec3(.61,.76,.65)*highlight*(.2+.32*strength);
  tint+=vec3(.63,.61,.25)*strength*(.22+.30*bulge);
  tint+=vec3(.55,.7,.61)*rim*.32+fineNoise;
  float innerRim=1.0-smoothstep(0.0,.04,band);
  float outerRim=smoothstep(.965,1.0,band);
  tint+=vec3(.43,.62,.52)*(innerRim*.11+outerRim*.15);
  float alpha=(.22+.36*sqrt(max(bulge,0.0))+.16*strength+highlight*.10)*radialMask*angularMask;
  gl_FragColor=vec4(tint,alpha);
}`;

function prepare() {
  if (runtime?.live) return { value: runtime, cold: false };
  if (runtime && !runtime.live) throw new Error("WebGL context unavailable");
  const started = performance.now();
  const canvas = document.createElement("canvas");
  canvas.className = "card-action-sectors card-action-webgl-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) throw new Error("WebGL unavailable");
  const shader = (type, source) => {
    const result = gl.createShader(type);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS))
      throw new Error("WebGL shader unavailable");
    return result;
  };
  const program = gl.createProgram();
  const vertex = shader(gl.VERTEX_SHADER, vertexSource);
  const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error("WebGL program unavailable");
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  gl.useProgram(program);
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(
    ["innerRadius", "sectorCount", "strengths", "lightPoint", "pixelSize"].map(
      (name) => [name, gl.getUniformLocation(program, name)],
    ),
  );
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  runtime = {
    gl,
    canvas,
    program,
    vertices,
    uniforms,
    live: true,
    initCpuMs: performance.now() - started,
    renderer: debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    timer: gl.getExtension("EXT_disjoint_timer_query"),
    query: null,
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    if (runtime?.canvas === canvas) runtime.live = false;
    activeSurface?.fallback("WebGL context lost — SVG fallback");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    runtime = null;
  });
  return { value: runtime, cold: true };
}

export function createWebGLWheel(layout, choose, report) {
  const base = createWheelSectors(layout, choose);
  const container = document.createElement("div");
  container.className = "wheel-webgl-surface";
  container.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:2";
  container.append(base.svg);
  let ready;
  let stats;
  let lastStrengths = new Array(layout.targets.length).fill(0);
  const fallback = (reason) => {
    ready = null;
    const canvas = container.querySelector("canvas");
    if (canvas) canvas.hidden = true;
    base.svg.style.opacity = "1";
    base.paint(lastStrengths);
    if (stats) stats.fallback = reason;
    report({ renderer: "svg-fallback", reason, stats });
  };
  try {
    const { value, cold } = prepare();
    ready = value;
    const { canvas, gl } = ready;
    const diameter = layout.radius * 2;
    const density = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = canvas.height = Math.ceil(diameter * density);
    canvas.style.width = canvas.style.height = diameter + "px";
    canvas.hidden = false;
    gl.viewport(0, 0, canvas.width, canvas.height);
    base.svg.style.opacity = "0";
    container.prepend(canvas);
    stats = {
      renderer: "webgl",
      backend: ready.renderer,
      cold,
      initCpuMs: cold ? ready.initCpuMs : 0,
      drawingBuffer: [canvas.width, canvas.height],
      drawCpuMs: [],
      gpuMs: [],
      gpuTimerAvailable: Boolean(ready.timer),
      idleLoop: false,
      backgroundRefraction: false,
    };
    report(stats);
  } catch (error) {
    fallback(error.message);
  }
  const strengths = new Float32Array(10);
  const paint = (values, point = layout.center) => {
    lastStrengths = values;
    if (!ready?.live) {
      base.paint(values);
      return;
    }
    const start = performance.now();
    const { gl, uniforms, timer } = ready;
    if (
      ready.query &&
      timer.getQueryObjectEXT(ready.query, timer.QUERY_RESULT_AVAILABLE_EXT)
    ) {
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT))
        stats.gpuMs.push(
          timer.getQueryObjectEXT(ready.query, timer.QUERY_RESULT_EXT) / 1e6,
        );
      timer.deleteQueryEXT(ready.query);
      ready.query = null;
    }
    let timing = false;
    if (timer && !ready.query) {
      ready.query = timer.createQueryEXT();
      timer.beginQueryEXT(timer.TIME_ELAPSED_EXT, ready.query);
      timing = true;
    }
    strengths.fill(0);
    strengths.set(values.slice(0, 10));
    gl.uniform1f(uniforms.innerRadius, layout.innerRadius / layout.radius);
    gl.uniform1f(uniforms.sectorCount, layout.targets.length);
    gl.uniform1fv(uniforms.strengths, strengths);
    gl.uniform2f(
      uniforms.lightPoint,
      (point.x - layout.center.x) / layout.radius,
      (point.y - layout.center.y) / layout.radius,
    );
    gl.uniform1f(uniforms.pixelSize, 2 / gl.drawingBufferWidth);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (timing) timer.endQueryEXT(timer.TIME_ELAPSED_EXT);
    if (stats.drawCpuMs.length < 1000)
      stats.drawCpuMs.push(performance.now() - start);
  };
  const surface = {
    ...base,
    svg: container,
    paint,
    fallback,
    destroy: () => {
      if (activeSurface === surface) activeSurface = null;
    },
  };
  activeSurface = surface;
  paint(lastStrengths);
  return surface;
}

window.addEventListener("pagehide", () => {
  activeSurface = null;
  runtime?.gl.getExtension("WEBGL_lose_context")?.loseContext();
  runtime = null;
});
