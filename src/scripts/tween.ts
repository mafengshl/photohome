// tween.js v25 适配：new Tween(obj) 默认不加入任何 Group，必须显式传 true
// 注册到全局 mainGroup，TWEEN.update() 才会驱动它（含 onComplete 回调）。
import * as TWEEN from '@tweenjs/tween.js';

export function createTween<T extends object>(obj: T): TWEEN.Tween<T> {
  return new TWEEN.Tween(obj, true);
}

export { TWEEN };
