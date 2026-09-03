import * as React from 'react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'

/**
 * Scroll reveal, in one place.
 *
 * The landing page had the same six motion props copy-pasted onto every
 * section, which is how the timings quietly drifted apart. One component means
 * one feel: a short rise and fade, once, on the way in.
 *
 * It reads prefers-reduced-motion and collapses to a plain fade — the movement
 * is decoration, the content is not, and somebody who has asked their operating
 * system for less of this has asked for a reason.
 */

const DISTANCE = 18

export function Reveal({
  children,
  delay = 0,
  direction = 'up',
  className,
  as = 'div',
}: {
  children: React.ReactNode
  delay?: number
  direction?: 'up' | 'left' | 'right' | 'none'
  className?: string
  as?: 'div' | 'section' | 'li'
}) {
  const still = useReducedMotion()
  const Tag = motion[as]

  const offset =
    still || direction === 'none'
      ? {}
      : direction === 'left'
        ? { x: -DISTANCE }
        : direction === 'right'
          ? { x: DISTANCE }
          : { y: DISTANCE }

  return (
    <Tag
      initial={{ opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, margin: '-70px' }}
      transition={{ duration: still ? 0.2 : 0.5, delay: still ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </Tag>
  )
}

/**
 * A group whose children arrive one after another.
 *
 * Used where a row of cards would otherwise all appear at once, which reads as
 * a flash rather than as a reveal. The stagger is small on purpose: long enough
 * to be a sequence, short enough that nobody waits for the last card.
 */
export const STAGGER: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.07 } },
}

export const STAGGER_ITEM: Variants = {
  hidden: { opacity: 0, y: DISTANCE },
  shown: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
}

export function RevealGroup({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const still = useReducedMotion()
  return (
    <motion.div
      variants={still ? undefined : STAGGER}
      initial={still ? undefined : 'hidden'}
      whileInView={still ? undefined : 'shown'}
      viewport={{ once: true, margin: '-60px' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function RevealItem({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const still = useReducedMotion()
  return (
    <motion.div variants={still ? undefined : STAGGER_ITEM} className={className}>
      {children}
    </motion.div>
  )
}

/** The hover lift shared by every card on the page. Kept as a class string so
 *  it stays a Tailwind concern and never fights Framer's transform. */
export const CARD_HOVER =
  'transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-1 hover:border-accent/40 hover:shadow-lg motion-reduce:hover:translate-y-0 motion-reduce:transition-none'
