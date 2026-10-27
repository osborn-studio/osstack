-- Synthetic, FK-valid held orphan. No real home, invocation, operator grant or stop evidence.
INSERT INTO broker_identity VALUES(1,'broker-fixture','osstack.resource-broker',1,1,'broker-owner-before-crash');
INSERT INTO broker_leases VALUES('lease-a','broker-fixture','home-a','scope-a','tenant-a','exclusive-resource-a','invocation-a',NULL,1,'held_orphan',0);
-- A broker-local takeover preserves the old invocation obligation and exclusive slot.
UPDATE broker_identity SET owner_generation=2,owner_ref='broker-recovery-owner';
