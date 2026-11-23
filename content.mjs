import twitterText from 'twitter-text';

const { extractUrlsWithIndices, parseTweet } = twitterText;
const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const couponDomains = ['coupang.com', 'coupang.co.kr', 'coupa.ng'];

export function isCouponUrl(value) {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return couponDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function attachment(post) {
  const extra = post.text_attachment;
  return extra?.text || extra?.plaintext || '';
}

export function postText(post) {
  const text = [post.text, attachment(post)].filter(Boolean).join('\n\n');
  const links = [post.link_attachment_url, post.text_attachment?.link_attachment_url];
  const missing = [...new Set(links.filter(link => link && !text.includes(link)))];
  return [text, ...missing].filter(Boolean).join('\n');
}

export function hasCoupon(post) {
  return extractUrlsWithIndices(postText(post)).some(({ url }) => isCouponUrl(url))
    || [post.link_attachment_url, post.text_attachment?.link_attachment_url].filter(Boolean).some(isCouponUrl);
}

function textAtoms(text) {
  const parts = [];
  let start = 0;
  for (const { indices: [from, to] } of extractUrlsWithIndices(text)) {
    parts.push(...Array.from(graphemes.segment(text.slice(start, from)), item => item.segment));
    parts.push(text.slice(from, to));
    start = to;
  }
  parts.push(...Array.from(graphemes.segment(text.slice(start)), item => item.segment));
  return parts;
}

export function splitText(text) {
  if (!text.trim()) return [];
  if (parseTweet(text).valid) return [text];
  const atoms = textAtoms(text);
  const parts = [];
  for (let start = 0; start < atoms.length;) {
    let end = start;
    let boundary = start;
    let part = '';
    while (end < atoms.length) {
      const next = part + atoms[end];
      if (parseTweet(next).weightedLength > 280) break;
      part = next;
      if (/\s/u.test(atoms[end])) boundary = end + 1;
      end++;
    }
    if (end === start) throw new Error('X 글자 제한 내에서 나눌 수 없는 문자가 있습니다.');
    if (end < atoms.length && boundary > start && boundary > end - 35) end = boundary;
    const segment = atoms.slice(start, end).join('').trim();
    if (segment) {
      if (!parseTweet(segment).valid) throw new Error('X에서 처리할 수 없는 문자가 포함되어 있습니다.');
      parts.push(segment);
    }
    start = end;
  }
  return parts;
}

function mediaGroups(items) {
  const groups = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (item.kind === 'image' && last?.[0].kind === 'image' && last.length < 4) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

export function plan(post, children = []) {
  let text = postText(post);
  const sources = children.length ? children : [post];
  const media = [];
  for (const item of sources) {
    const kind = item.gif_url ? 'gif' : { IMAGE: 'image', VIDEO: 'video' }[item.media_type];
    if (kind) media.push({ id: item.id, kind });
  }
  const needsOriginal = post.is_quote_post || post.reposted_post || post.poll_attachment
    || sources.some(item => item.media_type === 'AUDIO')
    || (['CAROUSEL', 'CAROUSEL_ALBUM'].includes(post.media_type) && !children.length);
  if ((needsOriginal || (!media.length && !text.trim())) && post.permalink && !text.includes(post.permalink)) {
    text = [text, post.permalink].filter(Boolean).join('\n\n');
  }

  const texts = splitText(text);
  const groups = mediaGroups(media);
  return Array.from({ length: Math.max(texts.length, groups.length) }, (_, index) => ({
    text: texts[index] || '', media: groups[index] || [],
  }));
}
