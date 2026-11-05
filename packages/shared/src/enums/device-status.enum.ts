/**
 * Status of an enrolled Android relay device
 */
export enum DeviceStatus {
  /** Generated pairing token; waiting for device enrollment */
  PENDING_PAIRING = 'PENDING_PAIRING',

  /** Enrolled, verified, and relaying notifications */
  ACTIVE = 'ACTIVE',

  /** Device heartbeat missed (> 15 minutes without sync) */
  DISCONNECTED = 'DISCONNECTED',

  /** Temporarily quarantined due to rate anomalies or security flags */
  QUARANTINED = 'QUARANTINED',

  /** Permanently revoked; all incoming tokens and signatures rejected */
  REVOKED = 'REVOKED',
}

/**
 * Ingestion mode of the Android relay device
 */
export enum DeviceIngestionMode {
  /** Mode 1: NotificationListenerService (Play Store compliant) */
  NOTIFICATION_LISTENER = 'NOTIFICATION_LISTENER',

  /** Mode 2: Direct BroadcastReceiver (Dedicated SIM phone) */
  SMS_RECEIVER = 'SMS_RECEIVER',

  /** Hybrid: Both modes active concurrently */
  HYBRID = 'HYBRID',
}

