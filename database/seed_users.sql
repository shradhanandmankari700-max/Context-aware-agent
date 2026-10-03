-- Owner: P6. Seed users for both tenants. Run this AFTER schema.sql.
-- Passwords are bcrypt hashes of: hospitalAdmin123, hospitalStaff123, hospitalViewer123,
-- hotelAdmin123, hotelStaff123, hotelViewer123
-- Generate fresh hashes: node -e "const b=require('bcryptjs'); console.log(b.hashSync('X',10))"

-- Tenants
INSERT INTO tenants (id, name) VALUES
  ('tenant-a', 'City Hospital'),
  ('tenant-b', 'Grand Hotel')
ON CONFLICT (id) DO NOTHING;

-- Hospital users (tenant-a)
INSERT INTO users (email, tenant_id, password_hash, role) VALUES
  ('admin@hospital.demo',  'tenant-a', '$2a$10$XvuAIiNp.p0E5RaHTNduyOsHkYqRq5eHJnmMqBgJfOjg/1aBPQPnK', 'admin'),
  ('staff@hospital.demo',  'tenant-a', '$2a$10$mGJnU8rHvB5J7K2Q9eNp7OkEu3l0hLVZWbRiTdHQ5aB3pCqMnGXzW', 'staff'),
  ('viewer@hospital.demo', 'tenant-a', '$2a$10$5nF0wYhQhOdOXxp3PJvGROkpkZ1Y0YfKf0YfF5oM5tJ7m9hgSk9L2', 'viewer')
ON CONFLICT (email) DO NOTHING;

-- Hotel users (tenant-b)
INSERT INTO users (email, tenant_id, password_hash, role) VALUES
  ('admin@hotel.demo',  'tenant-b', '$2a$10$XvuAIiNp.p0E5RaHTNduyOsHkYqRq5eHJnmMqBgJfOjg/1aBPQPnK', 'admin'),
  ('staff@hotel.demo',  'tenant-b', '$2a$10$mGJnU8rHvB5J7K2Q9eNp7OkEu3l0hLVZWbRiTdHQ5aB3pCqMnGXzW', 'staff'),
  ('viewer@hotel.demo', 'tenant-b', '$2a$10$5nF0wYhQhOdOXxp3PJvGROkpkZ1Y0YfKf0YfF5oM5tJ7m9hgSk9L2', 'viewer')
ON CONFLICT (email) DO NOTHING;
