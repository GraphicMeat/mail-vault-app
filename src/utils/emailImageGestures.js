import { attachImageDoubleClick } from './emailImages';
import { attachImageDrag } from './emailImageDrag';

export function attachImageGestures(doc, getAttachments) {
  const detachDoubleClick = attachImageDoubleClick(doc, getAttachments);
  const detachDrag = attachImageDrag(doc, getAttachments);
  return () => {
    detachDoubleClick();
    detachDrag();
  };
}
