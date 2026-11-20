/** Flacăra albastră a mărcii (decorativă). */
export default function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12.5 2.5c.6 3.2-1.2 4.9-2.7 6.6C8.3 10.8 7 12.4 7 14.8 7 17.7 9.2 20 12 20s5-2.3 5-5.2c0-1.7-.7-3-1.6-4.1-.3 1-.9 1.8-1.7 2.2.3-3.6-.6-7.2-1.2-10.4Z"
        fill="currentColor"
      />
      <path d="M12 21.5c-1.7 0-3.2-.6-4.3-1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}
