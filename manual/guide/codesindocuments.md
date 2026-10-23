# Codes in Documents

The Codes in Documents tool allows you to see how often particular codes appear in any given set of documents. Codes make up the rows of the table, and documents make up the columns. Each cell counts the number of selections coded with that code in that document.

**To open Codes in Documents:**

1. Click the `Analyse` button in the toolbar.

2. Choose `Codes in Documents`.

The tool contains:
- The [Document Selector](/guide/documentselector)
- The [Group By](/guide/grouping) function

<figure>
     <img src="./images/CodesInDocuments.png" alt="The Codes in Documents tool.">
     <figcaption>The Codes in Documents tool, with the results grouped by the Student type tag category.</figcaption>
</figure>

## Adding codes

**To add codes to the table:**

1. Drag the codes from the Code Browser into the `Results` box.

2. Each code appears as a row in the table. If you add both a code and its subcodes, the subcodes are indented beneath it.

3. To remove a code, click the `x` beside its name.

## Reading the results

Each cell shows how many selections in that document (or group of documents) are coded with that code.

- The `Total` column adds up each row, and the `Total` row adds up each column.
- The `% of Total` column shows each row's total as a percentage of the grand total.
- If you group by a tag category or a folder, its columns are followed by a `Subtotal` column and a `%` column. The `%` column shows the subtotal as a percentage of the row's total.

<figure>
     <img src="./images/CodesInDocumentsNumeric.png" alt="The results table.">
     <figcaption>The results table.</figcaption>
</figure>

You can change how the results are displayed using the buttons above the table. The first set of buttons chooses how the results are shown, and the second chooses what each cell counts. The highlighted buttons show the current choice.

| Button | Output |
| --- | --- |
| `Table` | Shows the results as numbers. This is the default. |
| `Visual` | Shows each cell as a coloured square, sized and shaded by its count. |
| `Sankey` | Shows the table as a Sankey diagram, with codes flowing into documents. |
| `Counts` | Shows how many selections are coded with that code in each cell. This is the default. |
| `Binary` | Shows `1` if the code appears in that document (or group of documents) and `0` if it does not. The totals then count how many documents (or groups) contain the code, rather than how many selections. You can use it with `Table`, `Visual` or `Sankey`. |

<figure>
     <img src="./images/CodesInDocumentsVisual.png" alt="The results in Visual view.">
     <figcaption>The Visual view.</figcaption>
</figure>

<figure>
     <img src="./images/CodesInDocumentsBinary.png" alt="The results in Binary view.">
     <figcaption>The Binary view.</figcaption>
</figure>

<figure>
     <img src="./images/CodesInDocumentsSankey.png" alt="The results in Sankey view.">
     <figcaption>The Sankey view.</figcaption>
</figure>

::: tip
Binary is useful when one long document would otherwise dominate your results. It answers the question "how many documents mention this?" rather than "how many times is this mentioned?".
:::

## Exploring the results

Click any cell with a count above zero to see its selections in the Query Results pane. Clicking a `Total` shows the selections for that whole row or column.

## Opening as a Framework Matrix

Once you can see where your codes appear, you may want to write a summary of what each code looks like in each document. Click `Open as Framework Matrix` to open a new [Framework Matrix](/guide/frameworkmatrix) with the same codes as columns and the same documents as rows.

- Tags, tag categories and folders you have grouped by become groups in the matrix, with their documents nested beneath them.
- Documents that are not in any group each get their own row.
- If you have chosen documents in `Select Documents`, the matrix includes only those documents. Its groups then stay limited to those documents, so a document you tag later is not added to them.

The new matrix is not saved until you click `Save Analysis` in it.

## Saving and exporting

You can save the analysis by clicking `Save Analysis`. It appears in the Analyses Panel. If you make changes later, click `Update Analysis` to save them.

You can export the table as a spreadsheet by clicking `Export CSV`.

You can also add the analysis to a [Report](/guide/reports) by dragging it from the Analyses Panel into the report.
