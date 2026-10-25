import { createRoot } from "react-dom/client";
import { useState, type FormEvent } from "react";
import "./styles.css";
import styles from "./orders.module.scss";

type View = "home" | "products" | "checkout" | "contact";

function FlowFixture() {
  const [view, setView] = useState<View>("home");
  const [menu, setMenu] = useState(false);
  const [modal, setModal] = useState(false);
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState(false);
  const navigate = (next: View) => { setView(next); setMenu(false); setInvalid(false); };
  const validate = (event: FormEvent) => { event.preventDefault(); setInvalid(!/.+@.+\..+/.test(email)); };

  return <>
    <header>
      <span className="brand">NovaStore · QA fixture</span>
      <button id="menuToggle" className="menu-toggle" aria-label="Open navigation menu" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>Menu</button>
      <nav className={menu ? "navigation open" : "navigation"} aria-label="Main navigation">
        <button id="tabHome" onClick={() => navigate("home")}>Home</button>
        <button id="tabProducts" onClick={() => navigate("products")}>Products</button>
        <button id="tabCheckout" onClick={() => navigate("checkout")}>Review order</button>
        <button id="tabContact" onClick={() => navigate("contact")}>Contact details</button>
      </nav>
    </header>
    <main>
      {view === "home" && <section>
        <h1>Welcome to NovaStore</h1>
        <p>This local test app contains six seeded application states and deliberate CSS defects.</p>
        <button id="btnOpenModal" onClick={() => setModal(true)}>View promotion</button>
      </section>}
      {view === "products" && <section>
        <h1>Product Catalog</h1>
        <div className="product-stack">
          <article id="productAlpha" className="product-card"><h2>Travel display</h2><p>A compact screen for your next trip.</p></article>
          <article id="productBeta" className="product-card"><h2>Studio display</h2><p>This card overlaps the preceding card because of its negative margin.</p></article>
        </div>
        <button id="btnReviewOrder" onClick={() => navigate("checkout")}>Review selected items</button>
      </section>}
      {view === "checkout" && <section>
        <h1>Order Checkout</h1>
        <p>Read-only order review. This fixture never purchases or sends anything.</p>
        <table id="orderTable" className={styles.orderTable}><thead><tr><th>Product description</th><th>SKU</th><th>Quantity</th><th>Price</th></tr></thead>
          <tbody><tr><td>Portable display with a deliberately wide table</td><td>SCREEN-PRO-2026</td><td>1</td><td>100 credits</td></tr></tbody></table>
      </section>}
      {view === "contact" && <section>
        <h1>{invalid ? "Check your details" : "Contact details"}</h1>
        <form onSubmit={validate} noValidate>
          <label htmlFor="contactEmail">Email for the local validation test</label>
          <input id="contactEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          <button id="btnValidate" type="submit">Validate details</button>
          {invalid && <div id="validationError" role="alert"><p>Enter a valid email address.</p><button id="btnEdit" type="button" onClick={() => setInvalid(false)}>Edit details</button></div>}
        </form>
      </section>}
    </main>
    {modal && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="promoTitle">
      <div className="modal-card"><h1 id="promoTitle">Special VIP Reward</h1><p>Preview of a promotion; no account or purchase is created.</p>
        <button id="btnCloseModal" onClick={() => setModal(false)}>Close promotion</button></div>
    </div>}
  </>;
}

createRoot(document.getElementById("root")!).render(<FlowFixture />);
