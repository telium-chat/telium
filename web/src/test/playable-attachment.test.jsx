import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Attachments, SealedAttachment } from '../views/chat/Attachments.jsx';
import {
  isGofileAttachment, isPlayableLink, PlayableAttachment, PlayableLink, playableKind, playableKindForUrl,
} from '../views/chat/PlayableAttachment.jsx';

vi.mock('../lib/upload.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchEncrypted: vi.fn(async () => new Blob(['decrypted bytes'], { type: 'audio/mpeg' })),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { delete navigator.serviceWorker; } catch {}
});

describe('playable attachment detection', () => {
  it('recognizes GoFile URLs and attachment origins', () => {
    expect(isGofileAttachment({}, 'https://store9.gofile.io/download/web/file/video.mp4')).toBe(true);
    expect(isGofileAttachment({ origin: 'gofile.io' }, 'blob:telium/video')).toBe(true);
    expect(isGofileAttachment({}, 'https://media.example/video.mp4')).toBe(false);
  });

  it('recognizes direct media links by their URL path', () => {
    const url = 'https://memes.20plays.com/data/posts/2541_ab0a97b9d1cc7027.mp4?download=1';
    expect(playableKindForUrl(url)).toBe('video');
    expect(isPlayableLink(url)).toBe(true);
    expect(isPlayableLink('https://store9.gofile.io/download/web/file.mp4')).toBe(false);
  });

  it('uses audio and video MIME types, including MIME parameters', () => {
    expect(playableKind({ name: 'recording.bin', mime: 'audio/mpeg' })).toBe('audio');
    expect(playableKind({ name: 'recording.bin', mime: 'video/mp4; codecs=avc1' })).toBe('video');
  });

  it('falls back to common filename extensions when MIME metadata is absent', () => {
    expect(playableKind({ name: 'recording.flac' })).toBe('audio');
    expect(playableKind({ name: 'clip.webm', mime: 'application/octet-stream' })).toBe('video');
    expect(playableKind({ name: 'notes.pdf', mime: 'application/pdf' })).toBeNull();
  });
});

describe('PlayableAttachment', () => {
  it('renders a direct video link with a player and original link', () => {
    const url = 'https://memes.20plays.com/data/posts/2541_ab0a97b9d1cc7027.mp4';
    const { container } = render(<PlayableLink url={url} />);
    expect(container.querySelector('video')).toBeTruthy();
    expect(container.querySelector('video source')).toBeNull();
    expect(container.querySelector(`a[href="${url}"]`)).toBeTruthy();
    expect(container.textContent).toContain('Hosted on memes.20plays.com');
    expect(container.firstChild.className).toContain('embed');
    expect(container.firstChild.className).toContain('embed--stack');
    expect(container.firstChild.className).not.toContain('border');
  });

  it('renders audio controls and keeps metadata above the direct URL player', async () => {
    const { container } = render(
      <PlayableAttachment
        att={{ name: 'recording.mp3', mime: '', size: 28.8 * 1024 ** 2 }}
        url="https://media.example/recording.mp3"
        host="media.example"
      />,
    );

    const audio = container.querySelector('audio');
    expect(audio).toBeTruthy();
    expect(audio.querySelector('source')).toBeNull();
    expect(audio.hasAttribute('controls')).toBe(false);
    expect(audio.getAttribute('preload')).toBe('none');
    expect(audio.getAttribute('src')).toBe('https://media.example/recording.mp3');
    expect(audio.hasAttribute('autoplay')).toBe(false);
    expect(audio.hasAttribute('loop')).toBe(false);
    expect(container.querySelector('a[href="https://media.example/recording.mp3"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Play recording.mp3 audio"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Seek recording.mp3 audio"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Mute recording.mp3 audio"]')).toBeTruthy();
    expect(container.textContent).toContain('recording.mp3');
    expect(container.textContent).toContain('28.8 MB');
    expect(container.textContent).toContain('Hosted on media.example');

    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    fireEvent.click(container.querySelector('button[aria-label="Play recording.mp3 audio"]'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio.querySelector('source')).toBeNull();
    play.mockRestore();
  });

  it('renders video controls and leaves unsupported files as ordinary cards', async () => {
    const { container, rerender } = render(
      <PlayableAttachment
        att={{ name: 'clip.mp4', mime: 'video/mp4', size: 1024 }}
        url="https://media.example/clip.mp4"
        host="media.example"
      />,
    );
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    Object.defineProperties(video, {
      duration: { configurable: true, value: 10 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
      currentTime: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBeCloseTo(0.01);
    expect(video.querySelector('source')).toBeNull();
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(video.hasAttribute('disableremoteplayback')).toBe(true);
    expect(video.getAttribute('controlslist')).toContain('noremoteplayback');
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.getAttribute('src')).toBe('https://media.example/clip.mp4');
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.className).toContain('w-auto');
    expect(video.className).toContain('max-w-full');
    expect(video.closest('.media-player-frame').className).toContain('w-fit');
    expect(container.querySelector('.media-player-controls').className).toContain('w-full');
    expect(container.querySelector('span[aria-live="off"]').className).not.toContain('hidden');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('loop')).toBe(false);
    expect(container.querySelector('a[href="https://media.example/clip.mp4"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Play clip.mp4 video"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Fullscreen clip.mp4 video"]')).toBeTruthy();
    expect(container.textContent).toContain('Hosted on media.example');

    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    fireEvent.click(container.querySelector('button[aria-label="Play clip.mp4 video"]'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.querySelector('source')).toBeNull();

    fireEvent.click(video);
    play.mockRestore();

    rerender(
      <PlayableAttachment
        att={{ name: 'archive.zip', mime: 'application/zip', size: 1024 }}
        url="https://media.example/archive.zip"
        host="media.example"
      />,
    );
    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('renders Gofile media when the caller supplies a homeserver playback URL', () => {
    const playback = 'https://home.example/_telium/v1/media/external/gofile/play?sig=signed';
    const { container } = render(
      <PlayableAttachment
        att={{
          name: 'music.mp3', mime: 'audio/mpeg', size: 1024,
          origin: 'store-na-phx-5.gofile.io',
        }}
        url={playback}
        host="store-na-phx-5.gofile.io"
      />,
    );

    expect(container.querySelector('audio')).toBeTruthy();
    expect(container.querySelector('audio').getAttribute('src')).toBe(playback);
    expect(container.textContent).toContain('Hosted on store-na-phx-5.gofile.io');
  });

  it('prepares browser Gofile video with a signed homeserver streaming URL', async () => {
    const source = 'https://store-na-phx-5.gofile.io/download/web/file-1/movie.mp4';
    const playback = 'https://home.example/_telium/v1/media/external/gofile/play?source=x&sig=y';
    const home = {
      post: vi.fn(async () => ({ url: playback, expires_at: Date.now() + 60_000 })),
    };

    const { container } = render(
      <StoreProvider store={{ home }}>
        <Attachments
          encrypted={false}
          base="https://guild.example"
          msg={{ attachments: [{
            external: true,
            provider: 'gofile',
            origin: 'store-na-phx-5.gofile.io',
            url: source,
            ref: 'external-gofile-video',
            name: 'movie.mp4',
            mime: 'video/mp4',
            size: 4096,
          }] }}
        />
      </StoreProvider>,
    );

    await waitFor(() => expect(container.querySelector('video')).toBeTruthy());
    expect(container.querySelector('video').getAttribute('src')).toBe(playback);
    expect(home.post).toHaveBeenCalledWith(
      '/_telium/v1/media/external/gofile/playback',
      { url: source },
    );
    expect(playback).not.toContain('accountToken');
    expect(container.querySelector(`a[href="${source}"]`)).toBeTruthy();
  });

  it('does not probe the homeserver when the operator disables the Gofile playback proxy', async () => {
    const source = 'https://store-na-phx-5.gofile.io/download/web/file-1/movie.mp4';
    const home = { post: vi.fn() };

    const { container } = render(
      <StoreProvider store={{ home, gofilePlaybackProxy: false }}>
        <Attachments
          encrypted={false}
          base="https://guild.example"
          msg={{ attachments: [{
            external: true,
            provider: 'gofile',
            origin: 'store-na-phx-5.gofile.io',
            url: source,
            ref: 'external-gofile-video-disabled',
            name: 'movie.mp4',
            mime: 'video/mp4',
            size: 4096,
          }] }}
        />
      </StoreProvider>,
    );

    await waitFor(() => expect(container.textContent).toContain('Open on Gofile'));
    expect(container.querySelector('video')).toBeNull();
    expect(home.post).not.toHaveBeenCalled();
    expect(container.querySelector(`a[href="${source}"]`)).toBeTruthy();
  });

  it('keeps multiple playable attachments independent', () => {
    const { container } = render(
      <div>
        <PlayableAttachment
          att={{ name: 'one.mp3', mime: 'audio/mpeg', size: 1 }}
          url="https://media.example/one.mp3"
          host="media.example"
        />
        <PlayableAttachment
          att={{ name: 'two.webm', mime: '', size: 2 }}
          url="https://media.example/two.webm"
          host="media.example"
        />
      </div>,
    );

    expect(container.querySelectorAll('audio')).toHaveLength(1);
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(container.textContent).toContain('one.mp3');
    expect(container.textContent).toContain('two.webm');
  });
});

describe('DM playable attachments', () => {
  it('decrypts once and keeps the handle for every row that shows the file', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:telium/audio');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const draw = () => render(
      <StoreProvider store={{ home: { base: 'https://home.example' } }}>
        <SealedAttachment
          att={{ ref: 'voice-1', name: 'voice.mp3', mime: 'audio/mpeg', size: 2048 }}
        />
      </StoreProvider>,
    );

    const first = draw();
    await waitFor(() => expect(first.container.querySelector('audio')).toBeTruthy());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(first.container.querySelector('audio source')).toBeNull();

    fireEvent.click(first.container.querySelector('button[aria-label="Play voice.mp3 audio"]'));
    await waitFor(() => expect(first.container.querySelector('audio').getAttribute('src'))
      .toBe('blob:telium/audio'));
    expect(first.container.querySelector('audio source')).toBeNull();

    first.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    const second = draw();
    await waitFor(() => expect(second.container.querySelector('audio')).toBeTruthy());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});

describe('a playable source that fails', () => {
  const att = { name: 'clip.mp4', mime: 'video/mp4', size: 1024, hash: 'abc123', capability: 'cap-1' };

  function renderPlayer(probe) {
    return render(
      <PlayableAttachment
        att={att}
        url="https://home.example/_telium/v1/media/abc123?cap=cap-1"
        host="home.example"
        probeUnavailable={probe}
      />,
    );
  }

  it('says a deleted or expired file is gone, and offers no dead link', async () => {
    const probe = vi.fn(async () => true);
    const { container } = renderPlayer(probe);
    fireEvent.error(container.querySelector('video'));
    await waitFor(() => expect(screen.getByText('This file was deleted or has expired')).toBeTruthy());
    expect(screen.queryByText(/Playback failed/)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps the recovery links when the origin still holds the file', async () => {
    const probe = vi.fn(async () => false);
    const { container } = renderPlayer(probe);
    fireEvent.error(container.querySelector('video'));
    await waitFor(() => expect(screen.getByText('Playback failed — open the original file')).toBeTruthy());
  });

  it('does not probe when there is nothing to probe with', () => {
    const probe = vi.fn(async () => true);
    const { container } = renderPlayer(null);
    fireEvent.error(container.querySelector('video'));
    expect(screen.getByText('Playback failed — open the original file')).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
  });
});
