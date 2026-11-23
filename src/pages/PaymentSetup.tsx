// Payments settings page: rider card + driver payouts in one place.
// A user with role "both" needs the two sections; the others simply ignore
// the section that does not apply to them.
import { Container } from 'react-bootstrap'
import DriverPayoutSetup from '../components/DriverPayoutSetup'
import RiderCardSetup from '../components/RiderCardSetup'

export default function PaymentSetup({ userId }: { userId: string }) {
  return (
    <Container className="py-4">
      <h2 className="mb-3">Payments</h2>
      <RiderCardSetup userId={userId} />
      <DriverPayoutSetup userId={userId} />
    </Container>
  )
}
