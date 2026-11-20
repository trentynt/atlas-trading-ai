import { setPrefs, usePrefs } from '../lib/prefs'
import { Drawer, Segmented, Toggle } from './ui'

/** Display preferences: saved in this browser only. */
export function PreferencesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePrefs()
  return (
    <Drawer open={open} onClose={onClose} title="Display preferences" width={460}>
      <div className="space-y-7">
        <section>
          <h3 className="text-[14px] font-medium text-white">Motion</h3>
          <p className="mt-1 mb-3 text-[13px] leading-snug text-ink-300">“Reduce” removes animation everywhere, including the research network. “System” follows your device setting.</p>
          <Segmented value={p.motion} onChange={(v) => setPrefs({ motion: v })}
            options={[{ value: 'system', label: 'System' }, { value: 'reduced', label: 'Reduce' }, { value: 'full', label: 'Allow' }]} />
        </section>

        <section>
          <h3 className="text-[14px] font-medium text-white">Price colours</h3>
          <p className="mt-1 mb-3 text-[13px] leading-snug text-ink-300">Some markets show rises in red. Gains and losses always carry a + or − sign as well, so colour is never the only cue.</p>
          <Segmented value={p.updown} onChange={(v) => setPrefs({ updown: v })}
            options={[{ value: 'green-up', label: 'Green up · red down' }, { value: 'red-up', label: 'Red up · green down' }]} />
          <div className="mt-3 flex items-center gap-5 text-[13px]" aria-hidden>
            <span className="num text-up">+1.24%</span><span className="num text-dn">−0.87%</span>
          </div>
        </section>

        <section>
          <h3 className="text-[14px] font-medium text-white">Research network</h3>
          <div className="mt-3 space-y-3">
            <Toggle checked={p.sphereSpin} onChange={(v) => setPrefs({ sphereSpin: v })} label="Rotate slowly when idle" />
            <Toggle checked={p.sphereStrands} onChange={(v) => setPrefs({ sphereStrands: v })} label="Show decorative strands (carry no data)" />
          </div>
          <p className="mt-3 text-[12.5px] leading-snug text-ink-300">Both are off by default. Light moves along a relationship only when a real research event happens.</p>
        </section>

        <p className="text-[12px] text-ink-300">Saved in this browser only.</p>
      </div>
    </Drawer>
  )
}
