import { t } from '../../lib/i18n/index.js';

export function PipIcon({ className = 'size-[18px]' }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 10V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5" />
      <rect x="12" y="13" width="9" height="7" rx="1.5" />
    </svg>
  );
}

export async function openFullscreen(element) {
  if (!element) throw new Error(t('voice.screen.noScreen'));
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) await document.exitFullscreen();
    else document.webkitExitFullscreen?.();
    return;
  }
  if (element.requestFullscreen) {
    await element.requestFullscreen();
    return;
  }
  if (element.webkitRequestFullscreen) {
    element.webkitRequestFullscreen();
    return;
  }
  throw new Error(t('voice.screen.noFullscreen'));
}

export async function openPictureInPicture(video) {
  if (!video) throw new Error(t('voice.screen.noVideo'));
  if (document.pictureInPictureElement === video) {
    await document.exitPictureInPicture?.();
    return;
  }
  if (document.pictureInPictureElement) await document.exitPictureInPicture?.();
  if (video.requestPictureInPicture) {
    await video.requestPictureInPicture();
    return;
  }
  if (video.webkitSetPresentationMode) {
    const next = video.webkitPresentationMode === 'picture-in-picture'
      ? 'inline'
      : 'picture-in-picture';
    video.webkitSetPresentationMode(next);
    return;
  }
  throw new Error(t('voice.screen.noPip'));
}
