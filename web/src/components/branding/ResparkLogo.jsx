import { Image } from '@/components/ui/image';

const assets = {
  wordmark: 'https://base44.app/api/apps/6ad0dedae8a9cd807152d78a/files/mp/public/6ad0dedae8a9cd807152d78a/2ab9f8aa4_respark_wordmark_forest_transparent.png',
  wordmarkLight: 'https://base44.app/api/apps/6ad0dedae8a9cd807152d78a/files/mp/public/6ad0dedae8a9cd807152d78a/bf4f98852_respark_wordmark_white_transparent.png',
  monogram: 'https://base44.app/api/apps/6ad0dedae8a9cd807152d78a/files/mp/public/6ad0dedae8a9cd807152d78a/0f9f44cee_respark_monogram_forest_transparent.png',
  monogramLight: 'https://base44.app/api/apps/6ad0dedae8a9cd807152d78a/files/mp/public/6ad0dedae8a9cd807152d78a/ebd86e610_respark_monogram_white_transparent.png',
};

export default function ResparkLogo({ light = false, monogram = false, decorative = false, className = '' }) {
  const key = `${monogram ? 'monogram' : 'wordmark'}${light ? 'Light' : ''}`;
  return <Image src={assets[key]} alt={decorative ? '' : 'Respark'} aria-hidden={decorative || undefined} fittingType="fit" className={`${monogram ? 'h-10 w-10' : 'h-14 w-40'} shrink-0 object-contain ${className}`} />;
}