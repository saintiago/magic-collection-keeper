import { clamp } from "./card-action-layout.js";

export function pointerTilt(bounds, point) {
  return {
    x: -clamp(((point.y - bounds.y) / bounds.height - 0.5) * 2, -1, 1) * 7,
    y: clamp(((point.x - bounds.x) / bounds.width - 0.5) * 2, -1, 1) * 7,
  };
}

export function approachTilt(current, target, elapsed = 16) {
  const amount = 1 - Math.exp(-Math.min(40, Math.max(1, elapsed)) / 65);
  const next = {
    x: current.x + (target.x - current.x) * amount,
    y: current.y + (target.y - current.y) * amount,
  };
  const settled =
    Math.abs(target.x - next.x) + Math.abs(target.y - next.y) < 0.025;
  return { ...(settled ? target : next), settled };
}

export function tiltTransform(tilt) {
  return `perspective(1100px) rotateX(${tilt.x.toFixed(3)}deg) rotateY(${tilt.y.toFixed(3)}deg)`;
}
