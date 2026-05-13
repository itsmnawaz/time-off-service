import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  Index,
} from 'typeorm';

/**
 * Represents a time-off balance for a specific employee at a specific location.
 * The composite (employeeId, locationId) pair is the primary business key
 * and mirrors how HCM tracks balances per dimension.
 *
 * `localBalance` is ExampleHR's authoritative view, updated optimistically
 * when requests are submitted and reconciled on every batch sync.
 *
 * `hcmBalance` caches the last value returned by HCM; it drives drift detection.
 */
@Entity('balances')
@Unique(['employeeId', 'locationId'])
@Index(['employeeId'])
@Index(['locationId'])
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  /**
   * The balance as ExampleHR understands it (approved + pending deductions applied).
   * Decremented optimistically when a request is submitted;
   * reconciled to hcmBalance on every successful HCM sync.
   */
  @Column({ type: 'float', default: 0 })
  localBalance: number;

  /**
   * Raw value last reported by HCM. Used to detect out-of-band changes
   * (e.g., anniversary bonuses applied directly in HCM).
   */
  @Column({ type: 'float', default: 0 })
  hcmBalance: number;

  /**
   * Days deducted for requests in PENDING or APPROVED state,
   * not yet committed to HCM or still awaiting manager approval.
   */
  @Column({ type: 'float', default: 0 })
  pendingDeductions: number;

  /**
   * Timestamp of the last successful read from HCM.
   */
  @Column({ nullable: true })
  lastHcmSyncAt: Date | null;

  /**
   * Version field for optimistic locking — prevents lost-update races
   * when two concurrent requests debit the same balance.
   */
  @Column({ type: 'integer', default: 0 })
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
