import { motion, useReducedMotion } from 'framer-motion'

/**
 * A quiet nod to the product name: three overlapping wave lines in the brand
 * triad (navy / ocean / teal), drifting almost imperceptibly. The one
 * deliberate decorative flourish on otherwise plain, functional auth screens.
 */
export function AuthWaves() {
  const shouldReduceMotion = useReducedMotion()
  const waves = [
    { d: 'M-100,220 C 150,140 350,300 600,220 S 950,140 1200,220', color: 'var(--navy)', opacity: 0.1, duration: 40 },
    { d: 'M-100,260 C 150,340 350,180 600,260 S 950,340 1200,260', color: 'var(--ocean)', opacity: 0.14, duration: 34 },
    { d: 'M-100,300 C 150,220 350,380 600,300 S 950,220 1200,300', color: 'var(--teal)', opacity: 0.18, duration: 28 },
  ]

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1100 440"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {waves.map((wave, i) => (
        <motion.path
          key={i}
          d={wave.d}
          fill="none"
          stroke={wave.color}
          strokeWidth={2}
          strokeOpacity={wave.opacity}
          strokeLinecap="round"
          animate={shouldReduceMotion ? undefined : { x: [0, -100, 0] }}
          transition={{ duration: wave.duration, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
    </svg>
  )
}
