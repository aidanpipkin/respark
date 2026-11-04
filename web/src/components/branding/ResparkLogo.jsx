import { Image } from '@/components/ui/image';

const assets = {
  wordmark: '/brand/respark_wordmark_forest_transparent.png',
  wordmarkLight: '/brand/respark_wordmark_white_transparent.png',
  monogram: '/brand/respark_monogram_forest_transparent.png',
  monogramLight: '/brand/respark_monogram_white_transparent.png',
};

export default function ResparkLogo({ light = false, monogram = false, decorative = false, className = '' }) {
  const key = `${monogram ? 'monogram' : 'wordmark'}${light ? 'Light' : ''}`;
  return <Image src={assets[key]} alt={decorative ? '' : 'Respark'} aria-hidden={decorative || undefined} fittingType="fit" className={`${monogram ? 'h-10 w-10' : 'h-14 w-40'} shrink-0 object-contain ${className}`} />;
}