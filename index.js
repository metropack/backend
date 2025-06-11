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

// Delete a variation
app.delete('/api/variations/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(`DELETE FROM product_variations WHERE id = $1`, [id]);
    res.json({ message: 'Variation deleted successfully' });
  } catch (error) {
    console.error('Error deleting variation:', error);
    res.status(500).json({ error: 'Failed to delete variation' });
  }
});

// Get all customers (with search)
app.get('/api/customers', async (req, res) => {
  const search = req.query.q || '';
  try {
    const result = await pool.query(
      `SELECT * FROM customers
       WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR company ILIKE $1
       ORDER BY created_at DESC
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
app.post('/api/customers/upsert', async (req, res) => {
  const {
    name = 'Unnamed',
    company = '',
    email = '',
    phone = '',
    address = ''
  } = req.body;

  if (!name && !company) {
    return res.status(400).json({ error: 'Customer must have a name or company' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO customers (name, company, email, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name, company) DO UPDATE SET
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         address = EXCLUDED.address
       RETURNING id`,
      [name, company, email, phone, address]
    );

    res.status(201).json({ message: 'Customer saved/updated', customerId: result.rows[0].id });
  } catch (error) {
    console.error('Error in /api/customers/upsert:', error);
    res.status(500).json({ error: 'Failed to save/update customer' });
  }
});

// Save a new estimate
app.post('/api/estimates', async (req, res) => {
  const { customerInfo, selectedItems } = req.body;

  try {
    const { name, company, email, phone, address } = customerInfo;
    const cleanedCustomerInfo = { name, company, email, phone, address };

    const estimateResult = await pool.query(
      `INSERT INTO estimates (customer_info, estimate_date)
       VALUES ($1, NOW())
       RETURNING id`,
      [cleanedCustomerInfo]
    );

    const estimateId = estimateResult.rows[0].id;

    for (const item of selectedItems) {
      if (!item.variationId) {
        console.warn(`Skipping custom item without variationId:`, item);
        continue;
      }

      await pool.query(
        `INSERT INTO estimate_items (estimate_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [estimateId, item.variationId, item.quantity]
      );
    }

    res.status(201).json({ message: 'Estimate saved', estimateId });
  } catch (error) {
    console.error('Error saving estimate:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all estimates with total amount
app.get('/api/estimates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        e.id,
        e.customer_info,
        e.estimate_date,
        ROUND(COALESCE((
          SELECT SUM(pv.price * ei.quantity)
          FROM estimate_items ei
          JOIN product_variations pv ON ei.product_variation_id = pv.id
          WHERE ei.estimate_id = e.id
        ), 0) * 1.06, 2) AS total
      FROM estimates e
      ORDER BY e.estimate_date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error retrieving estimates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get line items for a specific estimate
app.get('/api/estimates/:id/items', async (req, res) => {
  const estimateId = req.params.id;

  try {
    const result = await pool.query(`
      SELECT 
        p.name AS product_name,
        pv.size,
        pv.accessory,
        pv.price,
        ei.quantity
      FROM estimate_items ei
      JOIN product_variations pv ON ei.product_variation_id = pv.id
      JOIN products p ON pv.product_id = p.id
      WHERE ei.estimate_id = $1
    `, [estimateId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error retrieving estimate items:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an estimate
app.delete('/api/estimates/:id', async (req, res) => {
  const estimateId = req.params.id;

  try {
    await pool.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await pool.query(`DELETE FROM estimates WHERE id = $1`, [estimateId]);

    res.json({ message: 'Estimate deleted' });
  } catch (error) {
    console.error('Error deleting estimate:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save an invoice
app.post('/api/invoices', async (req, res) => {
  const { customerInfo, selectedItems } = req.body;

  try {
    const invoiceResult = await pool.query(
      `INSERT INTO invoices (customer_info, invoice_date, total)
       VALUES ($1, NOW(), $2)
       RETURNING id`,
      [customerInfo, 0] // Initial total will be updated later
    );

    const invoiceId = invoiceResult.rows[0].id;
    let total = 0;

    for (const item of selectedItems) {
      if (!item.variationId) {
        console.warn(`Skipping item without variationId:`, item);
        continue;
      }

      const variationResult = await pool.query(
        `SELECT price FROM product_variations WHERE id = $1`,
        [item.variationId]
      );

      if (variationResult.rows.length === 0) {
        console.error(`Variation ID ${item.variationId} not found`);
        continue;
      }

      const price = variationResult.rows[0].price;
      const quantity = item.quantity || 1;
      total += price * quantity;

      await pool.query(
        `INSERT INTO invoice_items (invoice_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [invoiceId, item.variationId, quantity]
      );
    }

    // Update the invoice with the calculated total (including 6% tax)
    const finalTotal = total * 1.06;
    await pool.query(
      `UPDATE invoices SET total = $1 WHERE id = $2`,
      [finalTotal, invoiceId]
    );

    res.status(201).json({ message: 'Invoice saved', invoiceId });
  } catch (error) {
    console.error('Error saving invoice:', error);
    res.status(500).json({ error: 'Failed to save invoice' });
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
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        i.id,
        i.customer_info,
        i.invoice_date,
        i.total,
        CONCAT('/invoices/', i.id, '.pdf') AS pdfLink
      FROM invoices i
      ORDER BY i.invoice_date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error retrieving invoices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is live on port ${PORT}`);
});


