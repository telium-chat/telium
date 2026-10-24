import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Embeds } from '../views/chat/Embeds.jsx';
import { EmbedVideo } from '../views/chat/EmbedVideo.jsx';

const CAMO = 'https://guild.example/_telium/v1/camo';
const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.restoreAllMocks();
});

const cards = new Map();

vi.mock('../lib/embeds.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, embedFor: vi.fn(async (api, url) => cards.get(url) || null) };
});

function fakeStore() {
  return {
    channels: new Map([['c1', { id: 'c1' }]]),
    apiForChannel: () => ({}),
    on: () => () => {},
  };
}

function show(card) {
  cards.clear();
  cards.set(card.url, card);
  return render(
    <StoreProvider store={fakeStore()}>
      <Embeds msg={{ id: 'm1', channel_id: 'c1', content: `look at this ${card.url}` }} />
    </StoreProvider>,
  );
}

describe('the link card', () => {
  it('names the host it belongs to and draws its still through the proxy', async () => {
    const { container } = show({
      url: 'https://news.example/story', url_hash: 'h1', status: 'ok', kind: 'link',
      title: 'A headline', description: 'A sentence about it.', site: 'news.example',
      image: `${CAMO}/abc`,
    });

    await screen.findByText('A headline');
    expect(screen.getByText('news.example')).toBeTruthy();
    expect(screen.getByText('A sentence about it.')).toBeTruthy();
    const image = container.querySelector('img');
    expect(image.getAttribute('src')).toBe(`${CAMO}/abc`);

    const embed = container.querySelector('.embed');
    expect(embed).toBeTruthy();
    expect(embed.className).not.toContain('border');
    expect(embed.getAttribute('style')).toBeNull();
  });

  it('pauses an extensionless camo GIF when the web app loses focus', async () => {
    let focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage }));
    const { container } = show({
      url: 'https://media.example/provider/content/abc123', url_hash: 'gif1',
      status: 'ok', kind: 'image', site: 'media.example', image: `${CAMO}/gif-hash`,
    });

    const image = await waitFor(() => {
      const value = container.querySelector('img');
      expect(value).toBeTruthy();
      return value;
    });
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 });
    fireEvent.load(image);

    focused = false;
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(drawImage).toHaveBeenCalledWith(image, 0, 0));
    expect(image.getAttribute('src')).toBeNull();

    focused = true;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(image.src).toBe(`${CAMO}/gif-hash`));
  });

  it('shows a long headline and a long description whole', async () => {
    const title = 'A headline long enough to need three lines of a narrow card '
      + 'before it reaches the end of what it has to say about the thing';
    const description = 'And a paragraph under it, already bounded by the server '
      + 'to the length a preview should be, which means the card can draw every '
      + 'word of what it was handed instead of guessing where to stop.';
    const { container } = show({
      url: 'https://news.example/story', url_hash: 'h2', status: 'ok', kind: 'link',
      title, description, site: 'news.example',
    });

    const headline = await screen.findByText(title);
    expect(headline.textContent).toBe(title);
    expect(headline.className).not.toContain('truncate');
    expect(headline.className).not.toContain('line-clamp');
    const paragraph = container.querySelector('.embed__text');
    expect(paragraph.textContent).toBe(description);
    expect(paragraph.className).not.toContain('truncate');
  });

  it('plays a video inline rather than handing the page to the site', async () => {
    const { container } = show({
      url: 'https://fixupx.com/xenovacom/status/2100692981632180468', url_hash: 'h3',
      status: 'ok', kind: 'video', title: 'A clip', site: 'fixupx.com',
      image: `${CAMO}/poster`, video: `${CAMO}/clip`, video_type: 'video/mp4',
      video_width: 1280, video_height: 720,
    });

    await waitFor(() => expect(container.querySelector('video')).toBeTruthy());
    expect(container.querySelector('iframe')).toBeNull();
    const video = container.querySelector('video');
    expect(video.getAttribute('poster')).toBe(`${CAMO}/poster`);
    expect(video.querySelector('source').getAttribute('src')).toBe(`${CAMO}/clip`);
    expect(video.querySelector('source').getAttribute('type')).toBe('video/mp4');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.getAttribute('preload')).toBe('none');
  });
});

describe('the inline player', () => {
  const card = {
    url: 'https://fixupx.com/x/status/1', title: 'A clip',
    image: `${CAMO}/poster`, video: `${CAMO}/clip`, video_type: 'video/mp4',
    video_width: 1280, video_height: 720,
  };

  it('holds its box open at the stated shape before a byte has arrived', () => {
    const { container } = render(<EmbedVideo card={card} />);
    expect(container.querySelector('.embed__player').style.getPropertyValue('--embed-ratio'))
      .toBe('1280 / 720');
    const { container: bare } = render(<EmbedVideo card={{ ...card, video_width: null, video_height: null }} />);
    expect(bare.querySelector('.embed__player').style.getPropertyValue('--embed-ratio')).toBe('');
  });

  it('starts from the click itself, which is what lets it have sound', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const { container } = render(<EmbedVideo card={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play video: A clip' }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector('video').hasAttribute('controls')).toBe(true);
    expect(container.querySelector('.embed__play')).toBeNull();
    play.mockRestore();
  });
});
