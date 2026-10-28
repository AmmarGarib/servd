// Shapes from the agreed contract (docs/rider-app.md). Keep in step with the
// backend's /rider-auth and /rider routes and with the web rider at
// frontend/storefront/src/app/rider/.

export type RiderStatus = 'available' | 'busy' | 'offline'
export type VehicleType = 'bike' | 'car' | 'bicycle' | 'foot'

export interface Rider {
  id: string
  name: string
  phone: string            // normalised 92… digits
  email?: string | null    // the @gsfoods.pk sign-in
  vehicleType: VehicleType | string
  status: RiderStatus | string
  companyName: string | null
}

export type JobStage = 'offered' | 'accepted' | 'picked_up' | 'arrived'

export interface JobPlace {
  name: string | null
  address: string | null
  lat: number | null
  lng: number | null
  phone: string | null
}

export interface Job {
  orderId: string
  orderNumber: string | number
  status: string             // the order's status (received … ready …)
  stage: JobStage
  brand: { name: string; slug: string }
  company: { id: string; name: string }   // the client company
  pickup: JobPlace                        // the kitchen
  dropoff: JobPlace                       // the customer; address = delivery notes text
  itemCount: number
  items: Array<{ name: string; qty: number }>
  cashToCollectCents: number              // 0 when prepaid
  notes: string | null
  assignedAt: string | null
  acceptedAt: string | null
  pickedUpAt: string | null
  arrivedAt: string | null
  otpAttemptsLeft: number | null
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  rider: Rider
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

/** A rider is on shift when the server says they are not offline. */
export function isOnShift(status: string | null | undefined): boolean {
  return status === 'available' || status === 'busy'
}

/** The job the rider is carrying right now (location fixes are tagged with it). */
export function carryingJob(jobs: Job[] | undefined): Job | null {
  return jobs?.find(j => j.stage === 'picked_up' || j.stage === 'arrived') ?? null
}
