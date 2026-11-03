import { useEffect } from 'react';

/**
 * The agent's brand (logo, colors) belongs on their public site and messages. Inside the
 * workspace the product keeps one consistent look; we only use the brand name for the tab title.
 */
export default function useBranding(settings) {
  useEffect(() => {
    const previous = document.title;
    document.title = settings?.brand_name ? `${settings.brand_name} · LeadRespark` : 'LeadRespark';
    return () => { document.title = previous; };
  }, [settings?.brand_name]);
}
