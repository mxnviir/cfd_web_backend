// Probe: does occt-wasm importStep convert units? Does exportStep convert
// or write as-is, and what SI_UNIT does it stamp?
import { OcctKernel } from "occt-wasm";

const k = await OcctKernel.init();

// A box 0.2 x 0.06 x 0.04 in METRES (a car-sized object drawn in m).
const mBox = k.makeBox(0.2, 0.06, 0.04);
const stepM = k.exportStep(mBox);
const unitLine = stepM.match(/SI_UNIT[^;]*;/g);
console.log("export of a metre box, SI_UNIT lines:", JSON.stringify(unitLine));
const coord = stepM.match(/CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([\d.Ee+-]+)/);
console.log("first CARTESIAN_POINT coord:", coord && coord[1]);

// Round-trip: import the metre STEP back. What size is the shape?
const back = k.importStep(stepM);
const bb = k.getBoundingBox(back);
console.log("re-imported metre STEP bbox:", JSON.stringify(bb));

// A box 200 x 60 x 40 in mm.
const mmBox = k.makeBox(200, 60, 40);
const stepMm = k.exportStep(mmBox);
console.log("export of a mm box, SI_UNIT lines:", JSON.stringify(stepMm.match(/SI_UNIT[^;]*;/g)));
const backMm = k.importStep(stepMm);
console.log("re-imported mm STEP bbox:", JSON.stringify(k.getBoundingBox(backMm)));

// Scale a metre shape to mm and export: label and coords.
const toMm = k.scale(mBox, { x: 0, y: 0, z: 0 }, 1000);
const stepToMm = k.exportStep(toMm);
console.log("export of scaled-to-mm box, SI_UNIT:", JSON.stringify(stepToMm.match(/SI_UNIT[^;]*;/g)));
const coord2 = stepToMm.match(/CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([\d.Ee+-]+)/);
console.log("first CARTESIAN_POINT coord:", coord2 && coord2[1]);
console.log("scaled shape bbox:", JSON.stringify(k.getBoundingBox(toMm)));

k.releaseAll();
console.log("probe done");
