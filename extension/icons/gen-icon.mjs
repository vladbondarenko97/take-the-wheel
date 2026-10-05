// Generates the Take the Wheel icon: a modernized take on the classic macOS rainbow
// "spinning wait cursor" (pinwheel/beachball) -- 8 radiating capsule blades fading around the
// circle to suggest spin, doubling as a steering-wheel pun for "Take the Wheel".
const CX = 64, CY = 64;
const COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#32ADE6', '#007AFF', '#5856D6', '#AF52DE'];
const OPACITIES = [1, 0.95, 0.89, 0.84, 0.78, 0.73, 0.67, 0.62]; // visible rainbow at 16px, still a gentle spin-fade
const N = 8;

const blades = [];
for (let i = 0; i < N; i++) {
  const angle = (360 / N) * i;
  blades.push(`<rect x="56" y="5" width="16" height="42" rx="8" fill="${COLORS[i]}" opacity="${OPACITIES[i]}" transform="rotate(${angle} ${CX} ${CY})"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <filter id="soft-shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.22"/>
    </filter>
    <radialGradient id="hub-sheen" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="55%" stop-color="#f4f4f6" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#d9dadf" stop-opacity="0.35"/>
    </radialGradient>
  </defs>
  <g filter="url(#soft-shadow)">
    ${blades.join('\n    ')}
    <circle cx="${CX}" cy="${CY}" r="15" fill="url(#hub-sheen)"/>
    <circle cx="${CX}" cy="${CY}" r="15" fill="none" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1"/>
  </g>
</svg>`;

console.log(svg);
