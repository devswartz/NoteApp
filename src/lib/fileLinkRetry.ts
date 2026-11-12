// An image whose signed upload link ran out (a page left open for hours, then scrolled, printed or
// re-laid out) is signed again once with the current key (shared/fileLinks.ts).
import { fileUrl } from '../api.ts';
import { unsignedUploadPath } from '../../shared/fileLinks.ts';

export function installFileLinkRetry() {
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || img.dataset.resigned) return;
      const plain = unsignedUploadPath(img.currentSrc || img.src);
      if (!plain) return;
      const next = new URL(fileUrl(plain), location.href).href;
      if (next === img.src) return; // same signature: really denied, not expired
      img.dataset.resigned = '1';
      img.src = next;
    },
    true, // error events don't bubble; catch them on the way down
  );
}
