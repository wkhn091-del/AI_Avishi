/**
 * Section title in expanded type, a line of figures under it, and the
 * section's controls on the right (below on narrow screens).
 * @param {{ id: string, title: string, meta?: string[], children?: import('react').ReactNode }} props
 */
export function SectionHeader({ id, title, meta = [], children }) {
  return (
    <div className="flex flex-col gap-6 pt-10 pb-8 sm:pt-14 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 id={id} className="font-wide text-[44px] leading-[0.95] font-extrabold tracking-[-0.01em] sm:text-[60px]">
          {title}
        </h1>
        <p className="mt-3 flex h-[22px] gap-5 text-[15px] text-graphite tabular-nums">
          {meta.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
