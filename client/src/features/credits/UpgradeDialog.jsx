import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';

const priceText = (count) => (count === 0 ? 'חינם' : count === 1 ? 'קרדיט אחד' : `${count} קרדיטים`);
const TITLES = { empty: 'נגמרו לך הקרדיטים', short: 'אין מספיק קרדיטים' };

/**
 * The credits dialog. A 402 opens it ("נגמרו לך הקרדיטים", or a project that needs more than the
 * balance), and so does the badge: the balance, what things cost, and the way to upgrade
 * (CREDITS_UPGRADE_URL on the server) or whom to ask.
 */
export function UpgradeDialog({ state, balance, info, onClose }) {
  const reason = state?.reason ?? 'info';
  const blocked = reason !== 'info';
  const title = TITLES[reason] ?? (info.unlimited ? 'שימוש ללא הגבלה' : 'הקרדיטים שלך');
  const text =
    reason === 'empty'
      ? 'כדי להמשיך לעבוד עם ה-AI צריך לשדרג את החשבון. השיחות, הקבצים והפרויקטים שלך נשמרים כמו שהם.'
      : reason === 'short'
        ? state.message
        : info.unlimited
          ? 'כמנהל המערכת, השימוש שלך ב-AI לא יורד מהיתרה.'
          : 'תשובות בפרימיום, פרויקטים של צוות הפיתוח ויצירת מדיה משתמשים בקרדיטים מהיתרה שלך.';
  return (
    <Modal open={Boolean(state)} onClose={onClose} labelledBy="credits-dialog-title" size="sm">
      <div className="p-6 text-center sm:p-7">
        <div aria-hidden="true" className="coin mx-auto grid size-20 place-items-center rounded-full text-[42px] leading-none">
          🪙
        </div>
        <h2 id="credits-dialog-title" className="mt-5 text-[21px] font-bold tracking-[-0.01em]">
          {title}
        </h2>
        <p className="mx-auto mt-2 max-w-[36ch] text-[14.5px] leading-relaxed text-graphite">{text}</p>

        {!info.unlimited && (
          <dl className="mt-5 flex items-stretch justify-center rounded-2xl bg-sunken py-3">
            <Stat label="היתרה שלך" value={balance ?? 0} danger={balance === 0} />
            {state?.needed ? (
              <>
                <span aria-hidden="true" className="w-px bg-line" />
                <Stat label="נדרשים" value={state.needed} />
              </>
            ) : null}
          </dl>
        )}

        <section className="mt-5 text-start" aria-labelledby="credits-prices">
          <h3 id="credits-prices" className="text-[13px] font-medium text-graphite">
            מה עולה כמה
          </h3>
          <ul className="mt-2 divide-y divide-line rounded-2xl border border-line text-[14px]">
            <Price label="תשובה בסביבת הפרימיום" value={info.pricing.answer} />
            <Price label="פרויקט של צוות הפיתוח, לכל קובץ" value={info.pricing.file} />
            <Price label="תמונה, קול, מוזיקה או וידאו" value={info.pricing.media} />
            <Price label="תשובה בסביבה החינמית" value={0} />
          </ul>
        </section>

        <div className="mt-6 flex flex-col gap-2">
          {!info.unlimited &&
            (info.upgradeUrl ? (
              <Button as="a" variant="primary" href={info.upgradeUrl} target="_blank" rel="noopener noreferrer" className="h-11 text-[15px]">
                שדרוג החשבון
              </Button>
            ) : (
              <p className="rounded-xl bg-sunken px-3 py-2.5 text-[13.5px] text-graphite">כדי לקבל עוד קרדיטים, פנו למנהל המערכת.</p>
            ))}
          <Button onClick={onClose}>{blocked ? 'אחר כך' : 'סגירה'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value, danger = false }) {
  return (
    <div className="px-7">
      <dt className="text-[12.5px] text-graphite">{label}</dt>
      <dd className={`mt-0.5 text-[26px] leading-tight font-bold tabular-nums ${danger ? 'text-danger' : 'text-ink'}`}>
        <bdi dir="ltr">{value}</bdi>
      </dd>
    </div>
  );
}

function Price({ label, value }) {
  return (
    <li className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <span>{label}</span>
      <span className="shrink-0 font-medium text-ink">{priceText(value)}</span>
    </li>
  );
}
