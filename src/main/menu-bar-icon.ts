import { nativeImage } from 'electron';

/** An 18pt transparent W template, rendered at 2x for the macOS menu bar. */
export function menuBarIcon(): Electron.NativeImage {
  const size=36, pixels=Buffer.alloc(size*size*4);
  const points=[[4,9],[10,28],[18,15],[26,28],[32,9]] as const;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    let distance=Infinity;
    for(let i=1;i<points.length;i++) {
      const [ax,ay]=points[i-1]!, [bx,by]=points[i]!;
      const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x+.5-ax)*dx+(y+.5-ay)*dy)/(dx*dx+dy*dy)));
      distance=Math.min(distance,Math.hypot(x+.5-ax-t*dx,y+.5-ay-t*dy));
    }
    pixels[(y*size+x)*4+3]=Math.round(255*Math.max(0,Math.min(1,2-distance)));
  }
  const icon=nativeImage.createFromBitmap(pixels,{width:size,height:size,scaleFactor:2});
  icon.setTemplateImage(true);
  return icon;
}
