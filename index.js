const express = require('express');
const cors = require('cors');
const pool = require('./db');
const fs = require('fs');
const path = require('path');

const app = express();



// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serve static PDF files
app.use('/invoices', express.static(path.join(__dirname, 'invoices')));

// Get all products and their variations
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id AS product_id,
        p.name,
        p.description,
        p.base_price,
        p.example_image,
        json_agg(json_build_object(
          'variation_id', v.id,
          'quantity', v.quantity,
          'size', v.size,
          'accessory', v.accessory,
          'price', v.price
        )) AS variations
      FROM products p
      INNER JOIN product_variations v ON p.id = v.product_id
      GROUP BY p.id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).send('Server error');
  }
});

// Add a new variation to a product
app.post('/api/products/:productId/variations', async (req, res) => {
  const { productId } = req.params;
  const { size, price, accessory } = req.body;

  if (!size || price == null) {
    return res.status(400).json({ error: 'Size and price are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO product_variations (product_id, size, price, accessory)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [productId, size, price, accessory || 'None']
    );

    res.status(201).json({ message: 'Variation added', variation: result.rows[0] });
  } catch (error) {
    console.error('Error adding new variation:', error);
    res.status(500).json({ error: 'Failed to add variation' });
  }
});

// Update variation price
app.put('/api/variations/:id/price', async (req, res) => {
  const { id } = req.params;
  const { price } = req.body;

  try {
    await pool.query(
      `UPDATE product_variations SET price = $1 WHERE id = $2`,
      [price, id]
    );
    res.json({ message: 'Price updated successfully' });
  } catch (error) {
    console.error('Error updating price:', error);
    res.status(500).json({ error: 'Failed to update price' });
  }
});



// Get all customers (with search)
app.get('/api/customers', async (req, res) => {
  const search = req.query.q || '';
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (name, company) * FROM customers
       WHERE (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR company ILIKE $1)
       ORDER BY name, company, created_at DESC
       LIMIT 10`,
      [`%${search}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Upsert a customer
// ✅ Upsert: reuse if same name + company (treat NULL same as empty string)
app.post('/api/customers/upsert', async (req, res) => {
  const {
    name = 'Unnamed',
    company = '',
    email = '',
    phone = '',
    address = ''
  } = req.body;

  if (!name.trim() && !company.trim()) {
    return res.status(400).json({ error: 'At least a name or company is required' });
  }

  try {
    // 1️⃣ Normalize: treat empty string as NULL for comparison
    const result = await pool.query(
      `SELECT id FROM customers 
       WHERE 
         COALESCE(name, '') = $1 AND 
         COALESCE(company, '') = $2
       LIMIT 1`,
      [name.trim(), company.trim()]
    );

    if (result.rows.length > 0) {
      // 2️⃣ If found: update contact info + return existing ID
      const customerId = result.rows[0].id;
      await pool.query(
        `UPDATE customers SET
          email = $1,
          phone = $2,
          address = $3
         WHERE id = $4`,
        [email, phone, address, customerId]
      );
      return res.json({ customerId });
    }

    // 3️⃣ Else insert new
    const insert = await pool.query(
      `INSERT INTO customers (name, company, email, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name.trim(), company.trim(), email, phone, address]
    );
    res.json({ customerId: insert.rows[0].id });

  } catch (err) {
    console.error('Error in upsert:', err);
    res.status(500).json({ error: 'Failed to upsert customer', details: err.message });
  }
});


// Save a new estimate
// ✅ CREATE a new estimate
// POST new estimate
app.post('/api/estimates', async (req, res) => {
  const { customer_id, customer_info, variationItems, customItems } = req.body;

  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id is required' });
  }

  try {
    // Calculate total
    let total = 0;

    // Sum variation items
    for (const item of variationItems || []) {
      const result = await pool.query(
        `SELECT price FROM product_variations WHERE id = $1`,
        [item.variation_id]
      );
      const price = result.rows[0]?.price || 0;
      total += price * item.quantity;
    }

    // Sum custom items
    for (const item of customItems || []) {
      total += parseFloat(item.price) * item.quantity;
    }

    // Add tax
    total = total * 1.06;

    // Insert estimate with total
    const estimateResult = await pool.query(
      `INSERT INTO estimates (customer_id, customer_info, store_info, estimate_date, total)
       VALUES ($1, $2, $3, NOW(), $4)
       RETURNING id`,
      [customer_id, customer_info, {}, total]
    );

    const estimateId = estimateResult.rows[0].id;

    // Insert variation items
    for (const item of variationItems || []) {
      await pool.query(
        `INSERT INTO estimate_items (estimate_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [estimateId, item.variation_id, item.quantity]
      );
    }

    // Insert custom items
    for (const item of customItems || []) {
      await pool.query(
        `INSERT INTO custom_estimate_items (estimate_id, product_name, size, price, quantity, accessory)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          estimateId,
          item.product_name,
          item.size,
          item.price,
          item.quantity,
          item.accessory
        ]
      );
    }

    res.status(201).json({ message: 'Estimate saved', estimateId });

  } catch (err) {
    console.error('Error saving estimate:', err);
    res.status(500).json({ error: 'Failed to save estimate', details: err.message });
  }
});




// ✅ UPDATE an existing estimate
app.put('/api/estimates/:id', async (req, res) => {
  const estimateId = req.params.id;
  const { customer_id, customer_info, variationItems, customItems } = req.body;

  try {
    let total = 0;

    for (const item of variationItems || []) {
      const result = await pool.query(
        `SELECT price FROM product_variations WHERE id = $1`,
        [item.variation_id]
      );
      const price = result.rows[0]?.price || 0;
      total += price * item.quantity;
    }

    for (const item of customItems || []) {
      total += parseFloat(item.price) * item.quantity;
    }

    total = total * 1.06;

    // Update main row with new info + total
    await pool.query(
      `UPDATE estimates
       SET customer_id = $1, customer_info = $2, estimate_date = NOW(), total = $3
       WHERE id = $4`,
      [customer_id, customer_info, total, estimateId]
    );

    // Clear old items
    await pool.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await pool.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);

    // Insert new variation items
    for (const item of variationItems || []) {
      await pool.query(
        `INSERT INTO estimate_items (estimate_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [estimateId, item.variation_id, item.quantity]
      );
    }

    // Insert new custom items
    for (const item of customItems || []) {
      await pool.query(
        `INSERT INTO custom_estimate_items (estimate_id, product_name, size, price, quantity, accessory)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          estimateId,
          item.product_name,
          item.size,
          item.price,
          item.quantity,
          item.accessory
        ]
      );
    }

    res.json({ message: 'Estimate updated', estimateId });

  } catch (err) {
    console.error('Error updating estimate:', err);
    res.status(500).json({ error: 'Failed to update estimate', details: err.message });
  }
});



// Get BOTH variation + custom items for ONE estimate
app.get('/api/estimates/:id/items', async (req, res) => {
  const estimateId = req.params.id;

  try {
    // ✅ Get variation items with product name
    const { rows: variationItems } = await pool.query(`
      SELECT 
        pv.id as variation_id,
        pv.size,
        pv.price,
        pv.accessory,
        pv.product_id,
        p.name as product_name,
        ei.quantity
      FROM estimate_items ei
      JOIN product_variations pv ON ei.product_variation_id = pv.id
      JOIN products p ON pv.product_id = p.id
      WHERE ei.estimate_id = $1
    `, [estimateId]);

    // ✅ Get custom items
    const { rows: customItems } = await pool.query(`
      SELECT 
        id as custom_id,
        product_name,
        size,
        price,
        quantity,
        accessory
      FROM custom_estimate_items
      WHERE estimate_id = $1
    `, [estimateId]);

    // ✅ Combine both into ONE ARRAY
    const combinedItems = [
      ...variationItems.map(v => ({
        type: 'variation',
        product_name: v.product_name,
        size: v.size,
        price: v.price,
        quantity: v.quantity,
        accessory: v.accessory,
        variation_id: v.variation_id
      })),
      ...customItems.map(c => ({
        type: 'custom',
        product_name: c.product_name,
        size: c.size,
        price: c.price,
        quantity: c.quantity,
        accessory: c.accessory,
        variation_id: null // no variation for custom items
      }))
    ];

    res.json(combinedItems);

  } catch (error) {
    console.error('Error fetching estimate items:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// Delete an estimate
app.delete('/api/estimates/:id', async (req, res) => {
  const estimateId = req.params.id;

  try {
    // Delete BOTH item types first
    await pool.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await pool.query(`DELETE FROM custom_items WHERE estimate_id = $1`, [estimateId]);

    // Then delete the main estimate record
    await pool.query(`DELETE FROM estimates WHERE id = $1`, [estimateId]);

    res.json({ message: 'Estimate deleted' });
  } catch (error) {
    console.error('Error deleting estimate:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Save an invoice
app.post('/api/invoices', async (req, res) => {
  const { customer_id, customer_info, variationItems, customItems } = req.body;

  try {
    // Create invoice
    const invoiceResult = await pool.query(
      `INSERT INTO invoices (customer_info, invoice_date, total)
       VALUES ($1, NOW(), $2)
       RETURNING id`,
      [customer_info, 0]
    );
    const invoiceId = invoiceResult.rows[0].id;
    let total = 0;

    // Insert variation items
    for (const item of variationItems || []) {
      const variationResult = await pool.query(
        `SELECT price FROM product_variations WHERE id = $1`,
        [item.variation_id]
      );
      const price = variationResult.rows[0]?.price || 0;
      total += price * item.quantity;

      await pool.query(
        `INSERT INTO invoice_items (invoice_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [invoiceId, item.variation_id, item.quantity]
      );
    }

    // Insert custom items
    for (const item of customItems || []) {
      total += parseFloat(item.price) * item.quantity;

      await pool.query(
        `INSERT INTO custom_invoice_items (invoice_id, product_name, size, price, quantity, accessory)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          invoiceId,
          item.product_name,
          item.size,
          item.price,
          item.quantity,
          item.accessory,
        ]
      );
    }

    // Update total with tax
    const finalTotal = total * 1.06;
    await pool.query(
      `UPDATE invoices SET total = $1 WHERE id = $2`,
      [finalTotal, invoiceId]
    );

    res.status(201).json({ message: 'Invoice saved', invoiceId });

  } catch (error) {
    console.error('❌ Error saving invoice:', error);
    res.status(500).json({ error: 'Failed to save invoice' });
  }
});


// ✅ Get all invoices with total + customer info + optional PDF link
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        i.id,
        i.customer_info,
        i.invoice_date,
        ROUND(i.total, 2) AS total
      FROM invoices i
      ORDER BY i.invoice_date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error retrieving invoices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ✅ Add to backend index.js
app.get('/api/invoices/:id/items', async (req, res) => {
  const invoiceId = req.params.id;

  try {
    const { rows: variationItems } = await pool.query(
      `SELECT pv.id as variation_id, pv.size, pv.price, pv.accessory, p.name as product_name, ii.quantity
       FROM invoice_items ii
       JOIN product_variations pv ON ii.product_variation_id = pv.id
       JOIN products p ON pv.product_id = p.id
       WHERE ii.invoice_id = $1`,
      [invoiceId]
    );

    const { rows: customItems } = await pool.query(
      `SELECT product_name, size, price, quantity, accessory
       FROM custom_invoice_items
       WHERE invoice_id = $1`,
      [invoiceId]
    );

    const combinedItems = [
      ...variationItems.map(v => ({
        type: 'variation',
        product_name: v.product_name,
        size: v.size,
        price: v.price,
        quantity: v.quantity,
        accessory: v.accessory,
        variation_id: v.variation_id
      })),
      ...customItems.map(c => ({
        type: 'custom',
        product_name: c.product_name,
        size: c.size,
        price: c.price,
        quantity: c.quantity,
        accessory: c.accessory,
        variation_id: null
      }))
    ];

    res.json(combinedItems);
  } catch (err) {
    console.error('Error fetching invoice items:', err);
    res.status(500).json({ error: 'Failed to load invoice items' });
  }
});


app.delete('/api/invoices/:id', async (req, res) => {
  const invoiceId = req.params.id;
  try {
    await pool.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM custom_invoice_items WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
    res.json({ message: 'Invoice deleted' });
  } catch (err) {
    console.error('Error deleting invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// Save PDF for an invoice
//app.post('/api/invoices/:id/pdf', async (req, res) => {
  //const { id } = req.params;
  //const { pdfData } = req.body;

//  if (!pdfData) {
  //  return res.status(400).json({ error: 'No PDF data provided' });
  //}

  //try {
   // const pdfBuffer = Buffer.from(pdfData.split(',')[1], 'base64');
    //const pdfPath = path.join(__dirname, 'invoices', `${id}.pdf`);

    // Ensure the invoices directory exists
//    if (!fs.existsSync(path.join(__dirname, 'invoices'))) {
  //    fs.mkdirSync(path.join(__dirname, 'invoices'));
    //}

//    fs.writeFile(pdfPath, pdfBuffer, (err) => {
  //    if (err) {
    //    console.error('Error saving PDF:', err);
      //  return res.status(500).json({ error: 'Failed to save PDF' });
      //}
      //res.json({ message: 'PDF saved', pdfLink: `/invoices/${id}.pdf` });
    //});
  //} catch (error) {
   // console.error('Error processing PDF:', error);
   // res.status(500).json({ error: 'Failed to process PDF' });
  //}
//});

// Get all invoices with total and PDF link
// Get ALL estimates with correct total (variations + custom)
app.get('/api/estimates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
  e.id,
  e.customer_info,
  e.estimate_date,
  ROUND((
    COALESCE((
      SELECT SUM(pv.price * ei.quantity)
      FROM estimate_items ei
      JOIN product_variations pv ON ei.product_variation_id = pv.id
      WHERE ei.estimate_id = e.id
    ), 0)
    +
    COALESCE((
      SELECT SUM(cei.price * cei.quantity)
      FROM custom_estimate_items cei
      WHERE cei.estimate_id = e.id
    ), 0)
  ) * 1.06, 2) AS total
FROM estimates e
ORDER BY e.estimate_date DESC;

    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error retrieving estimates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Delete a variation by ID
app.delete('/api/variations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM product_variations WHERE id = $1', [id]);
    res.json({ message: 'Variation deleted' });
  } catch (error) {
    console.error('Error deleting variation:', error);
    res.status(500).json({ error: 'Failed to delete variation' });
  }
});






const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is live on port ${PORT}`);
});

// Root route (optional, for testing in browser)
app.get('/', (req, res) => {
  res.send('Backend is working!');
});

// Favicon route (optional, avoids console error)
app.get('/favicon.ico', (req, res) => res.sendStatus(204));
