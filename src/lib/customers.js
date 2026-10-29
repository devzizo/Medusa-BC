// Pure mapping of Business Central customers to Medusa Admin API bodies.
// No I/O, so it is unit-tested on its own (test/customers.test.js).

const clean = (value) => JSON.parse(JSON.stringify(value));
const text = (value) => (typeof value === "string" ? value.trim() : "");
// Medusa validates emails; BC accepts anything in that field.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A BC customer as Medusa customer + address bodies. A person's display
 * name splits into first and last name; a company keeps it as the company
 * name. An email Medusa would reject is left out and reported.
 */
export const mapCustomer = (customer) => {
  const issues = [];
  const name = text(customer.displayName);
  const isCompany = customer.type === "Company";
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  const rawEmail = text(customer.email);
  const email = EMAIL.test(rawEmail) ? rawEmail.toLowerCase() : "";
  if (rawEmail && !email) issues.push({ kind: "email", ref: customer.number, message: `Email "${rawEmail}" is not valid; imported without it.` });
  const phone = text(customer.phoneNumber);
  const blocked = text(customer.blocked).replace(/_x0020_/g, " ").trim();

  const body = clean({
    email: email || undefined,
    phone: phone || undefined,
    company_name: isCompany ? name || undefined : undefined,
    first_name: isCompany ? undefined : first,
    last_name: isCompany ? undefined : rest.join(" ") || undefined,
    metadata: {
      bc_customer_id: customer.id,
      bc_customer_number: customer.number,
      bc_type: customer.type || undefined,
      bc_blocked: blocked || undefined,
      bc_last_modified: customer.lastModifiedDateTime,
    },
  });

  const hasAddress = text(customer.addressLine1) || text(customer.city);
  const address = hasAddress
    ? clean({
        address_name: "Business Central",
        is_default_shipping: true,
        is_default_billing: true,
        first_name: body.first_name,
        last_name: body.last_name,
        company: body.company_name,
        address_1: text(customer.addressLine1) || undefined,
        address_2: text(customer.addressLine2) || undefined,
        city: text(customer.city) || undefined,
        province: text(customer.state) || undefined,
        postal_code: text(customer.postalCode) || undefined,
        country_code: text(customer.country).toLowerCase() || undefined,
        phone: phone || undefined,
      })
    : null;

  return { body, address, issues };
};

// The metadata keys the sync owns. A key BC no longer gives is written as ""
// so it reads the same whether Medusa merges metadata or replaces it.
export const BC_METADATA_KEYS = ["bc_customer_id", "bc_customer_number", "bc_type", "bc_blocked", "bc_last_modified"];
const CUSTOMER_FIELDS = ["email", "phone", "first_name", "last_name", "company_name"];
export const ADDRESS_FIELDS = ["first_name", "last_name", "company", "address_1", "address_2", "city", "province", "postal_code", "country_code", "phone"];

const same = (a, b) => (a ?? "") === (b ?? "") || String(a ?? "") === String(b ?? "");

/** The full update body for a customer the sync owns: every field, absent ones emptied. */
export const customerUpdate = (body, current) => ({
  ...Object.fromEntries(CUSTOMER_FIELDS.map((field) => [field, body[field] ?? null])),
  metadata: { ...(current?.metadata ?? {}), ...Object.fromEntries(BC_METADATA_KEYS.map((key) => [key, body.metadata[key] ?? ""])) },
});

/** Whether Medusa's copy differs from what BC now says (so a second run changes nothing). */
export const customerChanged = (body, current) =>
  CUSTOMER_FIELDS.some((field) => !same(body[field], current[field])) ||
  BC_METADATA_KEYS.some((key) => !same(body.metadata[key], current.metadata?.[key]));

export const addressUpdate = (address) => Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, address[field] ?? null]));

export const addressChanged = (address, current) => ADDRESS_FIELDS.some((field) => !same(address[field], current[field]));
