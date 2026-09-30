import{D as e,F as t,Gt as n,Mt as r,Nt as i,Ot as a,U as o,Ut as s,Wt as c,_ as l,_t as u,a as d,at as f,d as p,l as m,o as h,ot as g,rt as _,st as v,u as y}from"./three-DRHjakRW.js";var b={paper:16777215,character:0,ink:0,dark:0,light:8421504,faint:12434877};function x(e){let[t,n,r]=e===`weapon`?[2,10,.1]:[8,32,.24];return`
  float penDistanceScale(float viewDepth) {
    // Orthographic plan views have no perspective distance shrinkage.
    if (projectionMatrix[2][3] != -1.0) return 1.0;
    float depthRatio = max(viewDepth - ${t.toFixed(1)}, 0.0) / ${n.toFixed(1)};
    return ${r} + ${(1-r).toFixed(2)} / (1.0 + depthRatio * depthRatio);
  }
`}var S=x(`world`);function C(e){let t=String(e),n=2166136261;for(let e=0;e<t.length;e++)n=Math.imul(n^t.charCodeAt(e),16777619);return n>>>0}function w(e){let t=e>>>0;return()=>{t=t+1831565813>>>0;let e=Math.imul(t^t>>>15,1|t);return e^=e+Math.imul(e^e>>>7,61|e),((e^e>>>14)>>>0)/4294967296}}function T(t,n={}){let r=t.onBeforeCompile,i=r.penBaseHook??r,a=t.customProgramCacheKey(),o=_.clamp(n.density??.65,0,1),s=Math.max(.01,n.scale??36),c=(n.seed??1)%8191,l=function(t,n){i.call(this,t,n),Object.assign(t.uniforms,{penPaper:{value:new e(b.paper)},penInk:{value:new e(b.ink)},penDark:{value:new e(b.dark)},penDensity:{value:o},penScale:{value:s},penSeedValue:{value:c}}),t.vertexShader=t.vertexShader.replace(`#include <common>`,`#include <common>
        varying vec3 vPenPosition;
        varying vec3 vPenNormal;`).replace(`#include <begin_vertex>`,`#include <begin_vertex>
        vPenPosition = position;
        vPenNormal = normal;`),t.fragmentShader=t.fragmentShader.replace(`#include <common>`,`#include <common>
        varying vec3 vPenPosition;
        varying vec3 vPenNormal;
        uniform vec3 penPaper;
        uniform vec3 penInk;
        uniform vec3 penDark;
        uniform float penDensity;
        uniform float penScale;
        uniform float penSeedValue;

        float penStroke(float phase, float width) {
          float footprint = max(fwidth(phase), 0.0001);
          float distanceToStroke = abs(fract(phase) - 0.5);
          float mark = 1.0 - smoothstep(width - footprint * 0.65, width + footprint * 0.65, distanceToStroke);
          // Subpixel hatch resolves to average pigment instead of sparkling.
          return mix(mark, min(width * 2.0, 1.0), smoothstep(0.35, 1.2, footprint));
        }
        float penHatch(vec2 p) {
          p += vec2(penSeedValue * 0.137, penSeedValue * 0.071);
          float first = p.x + p.y * 0.74 + 0.12 * sin(p.y * 1.9) + 0.055 * sin(p.x * 4.1);
          float second = p.x * 0.86 - p.y * 0.69 + 0.16 * sin(p.y * 1.25 + 1.7);
          float pressure = 0.82 + 0.18 * sin(p.y * 0.93 + p.x * 0.51);
          float width = mix(0.025, 0.25, penDensity) * pressure;
          float a = penStroke(first, width);
          float b = penStroke(second, width * 0.83) * smoothstep(0.18, 0.76, penDensity);
          float worked = penStroke(p.x * 0.43 + p.y * 1.21 + 0.16 * sin(p.y * 2.4), width * 0.61);
          worked *= smoothstep(0.58, 0.96, penDensity);
          return 1.0 - (1.0 - a) * (1.0 - b) * (1.0 - worked);
        }`).replace(`#include <color_fragment>`,`#include <color_fragment>
        vec3 penP = vPenPosition * penScale;
        vec3 penWeights = pow(abs(normalize(vPenNormal)), vec3(6.0));
        penWeights /= max(dot(penWeights, vec3(1.0)), 0.0001);
        float penCoverage = dot(penWeights, vec3(penHatch(penP.yz), penHatch(penP.xz), penHatch(penP.xy)));
        penCoverage *= step(0.001, penDensity);
        vec3 penPigment = mix(penInk, penDark, penCoverage * 0.6);
        diffuseColor.rgb = mix(penPaper, penPigment, penCoverage);`)};return l.penBaseHook=i,t.onBeforeCompile=l,t.customProgramCacheKey=()=>`${a}|ballpoint-v1:${o}:${s}:${c}`,t.userData.pen={density:o,scale:s,seed:c},t.needsUpdate=!0,t}var E=new e(b.paper),D={edge:new e(b.ink),detail:new e(b.ink),mesh:new e(b.light),landscape:new e(b.ink)};function O(t,n,r,i=.8,a={},o={positions:[],colors:[],widths:[],offsets:[]}){let s=w(n),l=new e,u=r===`mesh`,d=a.deviationScale??1,f=a.pressureScale??1,p=(e,t,n,a,c)=>{let p=e.distanceTo(t),m=Math.max(1,Math.min(12,Math.ceil(p*(a-n)/i))),h=s()*Math.PI*2,g=(u?.18:r===`edge`?.68:.42)*d,_=c?(s()<.5?-1:1)*(.65+s()*.7)*d:0,v=e=>_+Math.sin(e*Math.PI)*Math.sin(e*5.2+h)*g;for(let i=0;i<m;i++){let s=n+(a-n)*i/m,d=n+(a-n)*(i+1)/m;o.positions.push(e.x+(t.x-e.x)*s,e.y+(t.y-e.y)*s,e.z+(t.z-e.z)*s,e.x+(t.x-e.x)*d,e.y+(t.y-e.y)*d,e.z+(t.z-e.z)*d),o.offsets.push(v(s),v(d));let p=.5+.5*Math.sin(h+i*.73);o.widths.push(c?.68+p*.14:1-.16*f+p*.3*f);for(let e of[s,d]){let t=.5+.5*Math.sin(h+e*7.1),n=c?.28+t*.12:u?.05+t*.14:.025+t*.075;l.copy(D[r]).lerp(E,n),o.colors.push(l.r,l.g,l.b)}}},m=new c,h=new c;for(let e=0;e<t.length;e+=6){if(m.set(t[e],t[e+1],t[e+2]),h.set(t[e+3],t[e+4],t[e+5]),m.distanceToSquared(h)<1e-12)continue;p(m,h,0,1,!1);let n=r===`edge`?.38:r===`landscape`?.2:r===`detail`?.13:0;if(m.distanceTo(h)>i*.35&&s()<n*(a.retraceScale??1)){let e=s()*.35;p(m,h,e,Math.min(1,e+.3+s()*.46),!0)}}return o}function k(e){let t=new p({color:16777215,vertexColors:!0,linewidth:2.1,depthTest:!0,depthWrite:!1,alphaToCoverage:!0,toneMapped:!1});return t.onBeforeCompile=t=>{t.vertexShader=t.vertexShader.replace(`uniform float linewidth;`,`uniform float linewidth;
        ${x(e)}
        attribute float instancePenWidth;
        attribute vec2 instancePenOffset;`).replace(`// ndc space`,`// Foreground contours stay continuous with only a small pressure variation.
        float penStartScale = penDistanceScale(-start.z);
        float penEndScale = penDistanceScale(-end.z);
        float penWidthScale = (position.y < 0.5) ? penStartScale : penEndScale;
        vec2 penDirection = (clipEnd.xy / clipEnd.w - clipStart.xy / clipStart.w) * resolution;
        penDirection /= max(length(penDirection), 0.0001);
        vec2 penNormal = vec2(-penDirection.y, penDirection.x);
        clipStart.xy += penNormal * instancePenOffset.x * penStartScale * 2.0 / resolution * clipStart.w;
        clipEnd.xy += penNormal * instancePenOffset.y * penEndScale * 2.0 / resolution * clipEnd.w;
        // ndc space`).replace(`offset *= linewidth;`,`offset *= linewidth * instancePenWidth * penWidthScale;`)},t.customProgramCacheKey=()=>`ballpoint-foreground-edges-v4:${e}`,t}var A={world:k(`world`),weapon:k(`weapon`)},j=new n;function M(e,t,n){t.getViewport(j);let r=n.viewport;e.set(t.xr.isPresenting&&r?r.z:j.z,t.xr.isPresenting&&r?r.w:j.w)}function N(e,n,r=`detail`,i){let a=[`CylinderGeometry`,`SphereGeometry`,`ConeGeometry`,`TorusGeometry`,`CapsuleGeometry`].includes(e.type),o=new t(e,a?60:25),s=O(o.getAttribute(`position`).array,n,r,.07,{retraceScale:.18,deviationScale:.12,pressureScale:.25},i);return o.dispose(),s}function P(e,t,n=`detail`,r){let i=[];for(let t=1;t<e.length;t++)i.push(...e[t-1].toArray(),...e[t].toArray());return O(i,t,n,.07,{retraceScale:0,deviationScale:.12,pressureScale:.25},r)}function F(e,t,n){let r=new y().setPositions(e.positions).setColors(e.colors),i=e.widths.map(e=>e*t/A[n].linewidth);return r.setAttribute(`instancePenWidth`,new o(new Float32Array(i),1)),r.setAttribute(`instancePenOffset`,new o(new Float32Array(e.offsets),2)),r}function I(e,t){let n=A[t],r=new m(e,n);return r.name=`Continuous black pen edges`,r.userData.noCollision=!0,r.renderOrder=2,r.onBeforeRender=(e,t,r)=>{M(n.resolution,e,r),n.uniformsNeedUpdate=!0},r}var L=new Map;function R(t,n=2.1,r=b.ink,i=`world`){let o=new e(r),c=`${n}:${o.getHexString()}:${i}`,l=L.get(c);l||(l=new a({uniforms:{ink:{value:o},resolution:{value:new s(1,1)},width:{value:n}},vertexShader:`
        uniform vec2 resolution;
        uniform float width;
        ${x(i)}
        void main() {
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          vec4 clip = projectionMatrix * view;
          vec3 viewNormal = normalize(normalMatrix * normal);
          vec4 tip = projectionMatrix * vec4(view.xyz + viewNormal, 1.0);
          vec2 direction = (tip.xy * clip.w - clip.xy * tip.w) * resolution;
          direction /= max(length(direction), 0.0001);
          clip.xy += direction * width * penDistanceScale(-view.z) * 2.0 / resolution * clip.w;
          gl_Position = clip;
        }
      `,fragmentShader:`
        uniform vec3 ink;
        void main() {
          gl_FragColor = vec4(ink, 1.0);
          #include <colorspace_fragment>
        }
      `,side:1,depthTest:!0,depthWrite:!1,toneMapped:!1}),L.set(c,l));let u=l,d=new g(t,u);return d.name=`Black pen silhouette`,d.userData.noCollision=!0,d.renderOrder=1,d.onBeforeRender=(e,t,n)=>{M(u.uniforms.resolution.value,e,n),u.uniformsNeedUpdate=!0},d}var z=[`hips`,`spine`,`chest`,`neck`,`head`,`shoulder.L`,`shoulder.R`,`upper_arm.L`,`upper_arm.R`,`forearm.L`,`forearm.R`,`hand.L`,`hand.R`,`thigh.L`,`thigh.R`,`shin.L`,`shin.R`],B={"upper_arm.L":`forearm.L`,"upper_arm.R":`forearm.R`,"forearm.L":`hand.L`,"forearm.R":`hand.R`,"thigh.L":`shin.L`,"thigh.R":`shin.R`},V,H=new v({color:b.character,toneMapped:!1}),U=32,W={boneAxis:{value:Array.from({length:U},()=>new n(0,1,0,0))},boneOrigin:{value:Array.from({length:U},()=>new n(0,0,0,1))}},G=`
  uniform vec4 boneAxis[${U}];
  uniform vec4 boneOrigin[${U}];
  vec3 dqStretch1(vec3 p, int i) { vec4 o = boneOrigin[i]; vec3 a = boneAxis[i].xyz; return p + (o.w - 1.0) * dot(p - o.xyz, a) * a; }
  vec3 dqStretch(vec3 p) {
    return dqStretch1(p, int(skinIndex.x)) * skinWeight.x + dqStretch1(p, int(skinIndex.y)) * skinWeight.y
         + dqStretch1(p, int(skinIndex.z)) * skinWeight.z + dqStretch1(p, int(skinIndex.w)) * skinWeight.w;
  }
  vec4 dqMul(vec4 a, vec4 b) { return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
  vec4 dqRotOf(mat4 bone) {
    // Rotation only: divide out the bone's (uniform) scale, so a shrunk or enlarged bone still turns true.
    mat3 m = mat3(bone) / max(length(bone[0].xyz), 1e-6);
    float t = m[0][0] + m[1][1] + m[2][2]; vec4 q;
    if (t > 0.0) { float s = sqrt(t + 1.0) * 2.0; q = vec4((m[1][2] - m[2][1]) / s, (m[2][0] - m[0][2]) / s, (m[0][1] - m[1][0]) / s, 0.25 * s); }
    else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { float s = sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2.0; q = vec4(0.25 * s, (m[1][0] + m[0][1]) / s, (m[2][0] + m[0][2]) / s, (m[1][2] - m[2][1]) / s); }
    else if (m[1][1] > m[2][2]) { float s = sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2.0; q = vec4((m[1][0] + m[0][1]) / s, 0.25 * s, (m[2][1] + m[1][2]) / s, (m[2][0] - m[0][2]) / s); }
    else { float s = sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2.0; q = vec4((m[2][0] + m[0][2]) / s, (m[2][1] + m[1][2]) / s, 0.25 * s, (m[0][1] - m[1][0]) / s); }
    return normalize(q);
  }
  void dqAcc(mat4 m, float w, vec4 ref, inout vec4 r, inout vec4 d) {
    vec4 q = dqRotOf(m); if (dot(q, ref) < 0.0) q = -q;
    r += w * q; d += w * 0.5 * dqMul(vec4(m[3].xyz, 0.0), q);
  }
  vec3 dqRot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`,K=`
  #ifdef USE_SKINNING
    vec4 dqR = vec4(0.0), dqD = vec4(0.0), dqRef = dqRotOf(boneMatX);
    dqAcc(boneMatX, skinWeight.x, dqRef, dqR, dqD); dqAcc(boneMatY, skinWeight.y, dqRef, dqR, dqD);
    dqAcc(boneMatZ, skinWeight.z, dqRef, dqR, dqD); dqAcc(boneMatW, skinWeight.w, dqRef, dqR, dqD);
    float dqLen = length(dqR); dqR /= dqLen; dqD /= dqLen;
    // Scale blends like the weights: a bone shrunk to nothing (a lost limb) pulls its vertices onto its
    // joint, and a vertex shared with an unshrunk bone stays on that bone instead of flying off.
    float dqScale = skinWeight.x * length(boneMatX[0].xyz) + skinWeight.y * length(boneMatY[0].xyz)
                  + skinWeight.z * length(boneMatZ[0].xyz) + skinWeight.w * length(boneMatW[0].xyz);
  #endif
`,q=`
  #ifdef USE_SKINNING
    objectNormal = mat3(bindMatrixInverse) * dqRot(dqR, mat3(bindMatrix) * objectNormal);
  #endif
`,J=`
  #ifdef USE_SKINNING
    vec3 dqP = dqRot(dqR, dqScale * dqStretch((bindMatrix * vec4(transformed, 1.0)).xyz)) + 2.0 * (dqR.w * dqD.xyz - dqD.w * dqR.xyz + cross(dqR.xyz, dqD.xyz));
    transformed = (bindMatrixInverse * vec4(dqP, 1.0)).xyz;
  #endif
`;function Y(e){return e.replace(`#include <common>`,`#include <common>`+G).replace(`#include <skinbase_vertex>`,`#include <skinbase_vertex>`+K).replace(`#include <skinnormal_vertex>`,q).replace(`#include <skinning_vertex>`,J)}H.onBeforeCompile=e=>{e.vertexShader=Y(e.vertexShader),Object.assign(e.uniforms,W)};var X=new a({uniforms:{ink:{value:new e(b.character)},resolution:{value:new s(1,1)},width:{value:1.2},...W},vertexShader:Y(`
    #include <common>
    #include <skinning_pars_vertex>
    uniform vec2 resolution;
    uniform float width;
    void main() {
      #include <beginnormal_vertex>
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      vec4 view = modelViewMatrix * vec4(transformed, 1.0);
      vec4 clip = projectionMatrix * view;
      vec3 n = normalize(normalMatrix * objectNormal);
      vec4 tip = projectionMatrix * vec4(view.xyz + n, 1.0);
      vec2 direction = (tip.xy * clip.w - clip.xy * tip.w) * resolution;
      direction /= max(length(direction), 0.0001);
      clip.xy += direction * width * 2.0 / resolution * clip.w;
      gl_Position = clip;
    }
  `),fragmentShader:`
    uniform vec3 ink;
    void main() {
      gl_FragColor = vec4(ink, 1.0);
      #include <colorspace_fragment>
    }
  `,side:1,depthWrite:!1});function Z(e,t){X.uniforms.resolution.value.set(e,t)}function ee(e,t){let n=.92,r=t.geometry.attributes.position,i=t.geometry.attributes.skinIndex,a=t.geometry.attributes.skinWeight,o=new c;for(let s of[`L`,`R`]){let l=t=>e.getObjectByName(u.sanitizeNodeName(`${t}.${s}`)),d=l(`upper_arm`),f=l(`forearm`),p=l(`hand`),m=d.getWorldPosition(new c),h=p.getWorldPosition(new c),g=h.clone().sub(m).normalize(),v=m.distanceTo(h),y=new Set([d,f,p].map(e=>t.skeleton.bones.indexOf(e)));for(let e=0;e<r.count;e++){let n=0;for(let t=0;t<4;t++)y.has(i.getComponent(e,t))&&(n+=a.getComponent(e,t));if(!n)continue;t.localToWorld(o.fromBufferAttribute(r,e));let s=_.clamp(o.clone().sub(m).dot(g),0,v);o.addScaledVector(g,s*-.07999999999999996*n),t.worldToLocal(o),r.setXYZ(e,o.x,o.y,o.z)}f.position.multiplyScalar(n),p.position.multiplyScalar(n)}r.needsUpdate=!0,t.geometry.computeVertexNormals(),t.geometry.computeBoundingBox(),t.geometry.computeBoundingSphere(),e.updateMatrixWorld(!0)}var Q=new i(new c(0,.9,0),3.2),$;function te(){return $??=new d().loadAsync(`/dead-ink/preview/models/stickman.glb`).then(e=>{let t=e.scene,n=t.getObjectByName(`Stickman`);if(!n?.isSkinnedMesh)throw Error(`stickman.glb: SkinnedMesh "Stickman" not found`);n.geometry.attributes.normal||n.geometry.computeVertexNormals();for(let e of[`L`,`R`]){let n=t.getObjectByName(u.sanitizeNodeName(`hand.${e}`));n instanceof l&&(n.position.y+=.08)}return t.updateMatrixWorld(!0),ee(t,n),n.skeleton.calculateInverses(),t}).catch(e=>{throw $=void 0,e})}async function ne(){let e=h(await te()),t=e.getObjectByName(`Stickman`);t.material=H,t.boundingSphere=Q,e.updateMatrixWorld(!0);let i=new r(t.geometry,X);i.bind(t.skeleton,t.bindMatrix),i.boundingSphere=Q,i.renderOrder=1,i.name=`Stickman outline`;let a=new n;i.onBeforeRender=(e,t,n)=>{e.getViewport(a);let r=n.viewport;Z(e.xr.isPresenting&&r?r.z:a.z,e.xr.isPresenting&&r?r.w:a.w),X.uniformsNeedUpdate=!0},t.parent.add(i);let o={},s={};for(let t of z){let n=u.sanitizeNodeName(t),r=e.getObjectByName(n);if(!(r instanceof l))throw Error(`stickman.glb: bone "${t}" missing`);o[t]=r,s[t]={quat:r.quaternion.clone(),pos:r.position.clone(),node:n}}V=s;let c=new f,d=[];return t.skeleton.bones.forEach((e,n)=>{c.copy(t.skeleton.boneInverses[n]).invert(),W.boneAxis.value[n].set(c.elements[4],c.elements[5],c.elements[6],0).normalize(),W.boneOrigin.value[n].set(c.elements[12],c.elements[13],c.elements[14],1);let r=z.find(t=>s[t].node===e.name),i=r&&B[r];i&&d.push({index:n,child:o[i],restLen:s[i].pos.length()})}),t.onBeforeRender=()=>{for(let e of d)W.boneOrigin.value[e.index].w=e.child.position.length()/e.restLen},{root:e,mesh:t,bones:o,rest:s,resetPose(){for(let e of z)o[e].quaternion.copy(s[e].quat),o[e].position.copy(s[e].pos)}}}export{Z as a,I as c,P as d,b as f,O as g,F as h,V as i,S as l,C as m,B as n,T as o,w as p,ne as r,R as s,z as t,N as u};