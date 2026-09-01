-- A branch with nothing in it could not ask for anything.
--
-- Found on the hosted deployment. A fresh branch has no products, and the
-- enterprise catalogue had no active products either, so both existing request
-- types were dead ends: "more of something we already sell" had nothing to
-- restock, and "start carrying a product we do not stock" had nothing to carry.
-- The only way out was for an Administrator to hand-create the first product,
-- which is not a workflow, it is a prerequisite nobody documented.
--
-- So there is a third request type. It is deliberately a PROPOSAL, not a
-- creation: pos_products is enterprise-wide and has no branch column, so
-- letting a branch manager insert into it would let one branch add rows every
-- other branch sells. The manager describes the product they want; an
-- Administrator approves, and the approval creates it.
--
-- This extends the existing request engine rather than adding a second one.
-- The queue, the review authority, the one-reviewer concurrency guard, the
-- decline-needs-a-reason rule, the audit trail and the RLS are all inherited
-- unchanged. Only the shape of one row and one branch of the approval differ.

-- --------------------------------------------------------------- the type
alter type public.pos_request_type add value if not exists 'new_product';

-- ---------------------------------------------------------- the proposal
-- A proposal has no product yet, so product_id has to be nullable. It is set
-- on approval, which is what links the proposal to the product it produced.
alter table public.pos_inventory_requests
  alter column product_id drop not null;

alter table public.pos_inventory_requests
  add column if not exists proposed_category_id uuid references public.pos_product_categories(id),
  add column if not exists proposed_description text,
  add column if not exists proposed_selling_price numeric(12,2);

comment on column public.pos_inventory_requests.proposed_selling_price is
  'What the manager suggests charging. A suggestion: an Administrator sets the '
  'real price on approval, as they do for every other product.';
