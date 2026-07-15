import CouponEditor from '../CouponEditor';

/** Admin · Edit coupon — the editor bound to an existing coupon id. */
export default async function EditCouponPage({
  params,
}: {
  params: Promise<{ couponId: string }>;
}) {
  const { couponId } = await params;
  return <CouponEditor couponId={decodeURIComponent(couponId)} />;
}
